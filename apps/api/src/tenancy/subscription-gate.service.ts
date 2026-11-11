/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveGate, type EffectiveGate, type GateRow, OPEN_GATE } from './subscription-gate';
import { runGlobalWithoutTenant } from './tenant-context.storage';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * Cuánto vive la foto de las puertas que NO están abiertas.
 *
 * Esto corre en CADA petición de la API, así que no puede ser una consulta por
 * petición. Quince segundos es lo que tarda, como mucho, una réplica que no
 * recibió el `PUT` en enterarse; la que lo recibió invalida al momento.
 */
const SNAPSHOT_TTL_MS = 15_000;

/** Host → tenant de las peticiones sin sesión. Solo se consulta si hay alguna puerta cerrada. */
const HOST_TTL_MS = 60_000;
const MAX_HOSTS = 5_000;

interface Snapshot {
  gated: Map<string, GateRow>;
  expiresAt: number;
}

/**
 * Lee la puerta de suscripción de los tenants sin castigar la ruta caliente.
 *
 * La foto contiene SOLO las academias cuya puerta no está en `OPEN`. En una
 * instalación self-hosted esa lista está vacía siempre, así que el coste para
 * Community es una consulta cada quince segundos que no devuelve filas, y
 * ninguna resolución de host.
 */
@Injectable()
export class SubscriptionGateService {
  private readonly logger = new Logger(SubscriptionGateService.name);
  private snapshot: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private readonly hosts = new Map<string, { tenantId: string | null; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: TenantResolverService,
  ) {}

  /** La siguiente lectura va a la base. Lo llama quien acaba de mover una puerta. */
  invalidate(): void {
    this.snapshot = null;
  }

  /** ¿Hay alguna academia con la puerta en prueba o cerrada? */
  async anyGated(): Promise<boolean> {
    return (await this.load()).gated.size > 0;
  }

  /** Estado efectivo (prueba vencida = cerrada) de un tenant. */
  async gateFor(tenantId: string, now = Date.now()): Promise<EffectiveGate> {
    const row = (await this.load()).gated.get(tenantId);
    return row ? effectiveGate(row, now) : OPEN_GATE;
  }

  /**
   * Tenant de una petición sin sesión, por su host público. `null` si el host
   * no es de nadie o su tenant no está activo (ese caso ya lo cierran otras
   * puertas: un tenant suspendido no se sirve).
   */
  async tenantIdForHost(host: string | undefined): Promise<string | null> {
    if (!host) return null;
    const now = Date.now();
    const cached = this.hosts.get(host);
    if (cached && cached.expiresAt > now) return cached.tenantId;
    const tenant = await this.resolver.resolveByHost(host);
    if (this.hosts.size >= MAX_HOSTS) this.hosts.clear();
    this.hosts.set(host, { tenantId: tenant?.id ?? null, expiresAt: now + HOST_TTL_MS });
    return tenant?.id ?? null;
  }

  private async load(): Promise<Snapshot> {
    const current = this.snapshot;
    if (current && current.expiresAt > Date.now()) return current;
    if (this.inflight) return this.inflight;
    this.inflight = this.query()
      .then((gated) => {
        const fresh = { gated, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
        this.snapshot = fresh;
        return fresh;
      })
      .catch((err: unknown) => {
        // Falla ABIERTA, y a propósito: si la base no contesta, el contenido
        // tampoco se va a servir, y convertir un parpadeo de la base en un 402
        // para todas las academias del pool sería peor que el problema. Se
        // conserva la última foto buena si la había.
        this.logger.warn(
          `No se pudo leer la puerta de suscripción: ${err instanceof Error ? err.message : String(err)}`,
        );
        const fallback = {
          gated: current?.gated ?? new Map<string, GateRow>(),
          expiresAt: Date.now() + SNAPSHOT_TTL_MS,
        };
        this.snapshot = fallback;
        return fallback;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async query(): Promise<Map<string, GateRow>> {
    // `tenant` es global y esta lectura es de infraestructura: cruza todos los
    // tenants, así que sale del contexto de la petición (que puede traer el de
    // quien llama) y va sancionada.
    const rows = await runGlobalWithoutTenant(() =>
      this.prisma.tenant.findMany({
        where: { deletedAt: null, subscriptionGateState: { not: 'OPEN' } },
        select: {
          id: true,
          subscriptionGateState: true,
          subscriptionTrialEndsAt: true,
          subscriptionActionUrl: true,
        },
      }),
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          subscriptionGateState: r.subscriptionGateState,
          subscriptionTrialEndsAt: r.subscriptionTrialEndsAt,
          subscriptionActionUrl: r.subscriptionActionUrl,
        },
      ]),
    );
  }
}
