/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ClientContext } from '../../auth/client-context';
import { PayoutsBrandingSync } from '../../modules/payouts/payouts-branding.sync';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicSeoService } from '../../public/public-seo.service';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import {
  ADDRESS_CHANGE_WINDOW_DAYS,
  ADDRESS_CHANGED_ACTION,
  MAX_ADDRESS_CHANGES,
  changeAllowance,
  changeWindowStart,
  checkLabel,
  hostnameFor,
  labelOf,
  normalizeLabel,
  resolveSubdomainSuffix,
} from './academy-address.rules';

/**
 * «Dirección de tu academia»: el administrador de un aula cambia él solo su
 * subdominio (`<x>.didacta.io` → `<y>.didacta.io`) sin que intervenga nadie.
 *
 * Solo existe si la instancia configura `TENANT_SUBDOMAIN_SUFFIX`: sin ella,
 * todas las operaciones responden 404 y la web no pinta nada. Un self-hoster
 * con su dominio propio no ve la función.
 *
 * Al cambiar:
 *  - la dirección nueva pasa a ser el dominio primario del aula (correos,
 *    enlaces, buscadores, Stripe…);
 *  - la vieja se queda PARA SIEMPRE como dirección anterior del aula
 *    (`redirectToPrimary`): sigue resolviendo el aula —nadie más puede
 *    quedársela, así que un enlace viejo no se puede suplantar— y el web
 *    redirige sus páginas (308) a la nueva. `/api/*` no se redirige: webhooks
 *    y clientes que la tengan registrada siguen funcionando;
 *  - cuenta para el límite (3 cada 30 días), que se lleva en el propio audit
 *    log: la fila del cambio y el cambio se escriben en la MISMA transacción.
 *
 * Lo que NO hace: cambiar el `slug` del aula. El slug es un identificador
 * interno (rutas de almacenamiento, compatibilidad del acceso por slug, el
 * enlace con el plano de control) y la dirección es lo único que ve la gente.
 */

/** Por qué no se puede cambiar ahora (si no se puede). */
export type AddressBlockedReason = 'no_address' | 'own_domain' | 'limit';

export interface AcademyAddressState {
  /** Parte fija de la dirección: `didacta.io`. */
  suffix: string;
  /** Dirección actual completa, o null si el aula no tiene dominio de la app. */
  hostname: string | null;
  /** Lo que el administrador puede cambiar; null si su dirección no cuelga del sufijo. */
  label: string | null;
  canChange: boolean;
  blockedReason: AddressBlockedReason | null;
  maxChanges: number;
  windowDays: number;
  changesLeft: number;
  /** ISO; solo cuando se ha agotado el límite: cuándo vuelve a quedar un cambio. */
  nextChangeAt: string | null;
}

export type AddressAvailabilityStatus = 'available' | 'current' | 'invalid' | 'reserved' | 'taken';

export interface AddressAvailability {
  /** Lo pedido, normalizado. */
  label: string;
  /** La dirección completa; null si la etiqueta no es válida. */
  hostname: string | null;
  status: AddressAvailabilityStatus;
}

export interface AddressChangeResult {
  previousHostname: string;
  hostname: string;
  state: AcademyAddressState;
}

/** Espacio del advisory lock que serializa los cambios de dirección de un aula. */
const ADDRESS_LOCK_SPACE = 'academy_address';
/** Tiempos de la transacción del cambio (incluye esperar el lock de la cadena). */
const CHANGE_TX_TIMEOUT_MS = 15_000;

@Injectable()
export class AcademyAddressService {
  private readonly logger = new Logger(AcademyAddressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    // Solo existe con los cobros de plataforma: la web del negocio en Stripe.
    @Optional() private readonly paymentsBranding?: PayoutsBrandingSync,
    // Para olvidar la caché de buscadores del aula (canonical y sitemap).
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** El sufijo configurado, o null si la función está apagada en esta instancia. */
  suffix(): string | null {
    return resolveSubdomainSuffix();
  }

  async getState(tenantId: string, now: Date = new Date()): Promise<AcademyAddressState> {
    const suffix = this.requireSuffix();
    const [primary, recent] = await runAsTenant(tenantId, () =>
      Promise.all([this.findPrimary(tenantId), this.recentChanges(tenantId, now)]),
    );
    return this.buildState(suffix, primary, recent, now);
  }

  async checkAvailability(tenantId: string, raw: string): Promise<AddressAvailability> {
    const suffix = this.requireSuffix();
    const label = normalizeLabel(raw);
    const check = checkLabel(label);
    if (check === 'invalid') return { label, hostname: null, status: 'invalid' };
    const hostname = hostnameFor(label, suffix);
    if (check === 'reserved') return { label, hostname, status: 'reserved' };

    const primary = await runAsTenant(tenantId, () => this.findPrimary(tenantId));
    if (primary === hostname) return { label, hostname, status: 'current' };
    if (await this.isTakenByOther(tenantId, label, hostname)) {
      return { label, hostname, status: 'taken' };
    }
    return { label, hostname, status: 'available' };
  }

  async change(
    tenantId: string,
    actorId: string | null,
    raw: string,
    ctx: ClientContext = { ip: null, userAgent: null },
    now: Date = new Date(),
  ): Promise<AddressChangeResult> {
    const state = await this.getState(tenantId, now);
    if (!state.canChange) throw blocked(state);

    const availability = await this.checkAvailability(tenantId, raw);
    if (availability.status !== 'available' || !availability.hostname) {
      throw unavailable(availability);
    }
    const hostname = availability.hostname;

    let previousHostname: string;
    try {
      previousHostname = await runAsTenant(tenantId, () =>
        this.prisma.$transaction(
          async (tx) => {
            // Un cambio de dirección del aula detrás de otro: el recuento del
            // límite y la escritura no pueden intercalarse con los de otra
            // petición (doble clic, dos administradores a la vez).
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADDRESS_LOCK_SPACE}), hashtext(${tenantId}))`;

            const recent = await tx.auditLog.findMany({
              where: {
                tenantId,
                action: ADDRESS_CHANGED_ACTION,
                timestamp: { gt: changeWindowStart(now) },
              },
              select: { timestamp: true },
            });
            const allowance = changeAllowance(
              recent.map((r) => r.timestamp),
              now,
            );
            if (allowance.left === 0) {
              throw blocked({
                ...state,
                canChange: false,
                blockedReason: 'limit',
                changesLeft: 0,
                nextChangeAt: allowance.nextChangeAt?.toISOString() ?? null,
              });
            }

            const current = await tx.tenantDomain.findFirst({
              where: { tenantId, isPrimary: true, surface: 'APP' },
              select: { hostname: true },
            });
            if (!current) throw blocked({ ...state, blockedReason: 'no_address' });
            if (current.hostname === hostname) {
              throw unavailable({ ...availability, status: 'current' });
            }

            // La dirección que se deja pasa a ser dirección anterior: sigue
            // siendo del aula y sus páginas redirigen a la nueva.
            await tx.tenantDomain.updateMany({
              where: { tenantId, isPrimary: true, surface: 'APP' },
              data: { isPrimary: false, redirectToPrimary: true },
            });
            // Volver a una dirección anterior propia es reactivarla; una nueva
            // se crea. Si otra aula se la ha quedado entre la comprobación y
            // aquí, el índice único de `hostname` lo para (P2002 → ocupada).
            const own = await tx.tenantDomain.findFirst({
              where: { tenantId, hostname },
              select: { id: true },
            });
            if (own) {
              await tx.tenantDomain.update({
                where: { id: own.id },
                data: { isPrimary: true, isVerified: true, redirectToPrimary: false },
              });
            } else {
              await tx.tenantDomain.create({
                data: {
                  tenantId,
                  hostname,
                  isPrimary: true,
                  isVerified: true,
                  surface: 'APP',
                  redirectToPrimary: false,
                },
              });
            }

            await this.auditLog.recordInTransaction(tx, {
              tenantId,
              actorId,
              action: ADDRESS_CHANGED_ACTION,
              resourceType: 'tenant',
              resourceId: tenantId,
              metadata: { previousHostname: current.hostname, hostname },
              ...(ctx.ip ? { ip: ctx.ip } : {}),
              ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
            });
            return current.hostname;
          },
          { maxWait: CHANGE_TX_TIMEOUT_MS, timeout: CHANGE_TX_TIMEOUT_MS },
        ),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw unavailable({ ...availability, status: 'taken' });
      }
      throw err;
    }

    this.logger.log(
      `Aula ${tenantId}: dirección cambiada de ${previousHostname} a ${hostname} por ${actorId ?? 'desconocido'}`,
    );
    this.afterChange(tenantId);
    return { previousHostname, hostname, state: await this.getState(tenantId, now) };
  }

  /**
   * Lo que guarda la dirección fuera de `tenant_domain` y no la calcula al
   * vuelo. Nada de esto puede deshacer el cambio: es en segundo plano y cada
   * pieza se repone sola si falla (la marca de Stripe se revisa como mucho cada
   * 10 minutos al abrir una ficha de venta; la caché de buscadores caduca en 60
   * segundos).
   */
  private afterChange(tenantId: string): void {
    // La web del negocio en la cuenta conectada de Stripe.
    this.paymentsBranding?.request(tenantId);
    // Canonical, sitemap y robots del aula.
    try {
      this.moduleRef?.get(PublicSeoService, { strict: false }).invalidate(tenantId);
    } catch {
      // Sin el servicio (tests, despliegue sin el módulo público): caduca solo.
    }
  }

  private requireSuffix(): string {
    const suffix = this.suffix();
    if (!suffix) {
      throw new NotFoundException({
        message: 'Esta instalación no permite cambiar la dirección del aula.',
        code: 'ACADEMY_ADDRESS_DISABLED',
      });
    }
    return suffix;
  }

  /** El dominio primario de la app del aula (lo lee con RLS del aula). */
  private async findPrimary(tenantId: string): Promise<string | null> {
    const row = await this.prisma.tenantDomain.findFirst({
      where: { tenantId, isPrimary: true, surface: 'APP' },
      select: { hostname: true },
    });
    return row?.hostname ?? null;
  }

  private async recentChanges(tenantId: string, now: Date): Promise<Date[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        action: ADDRESS_CHANGED_ACTION,
        timestamp: { gt: changeWindowStart(now) },
      },
      select: { timestamp: true },
    });
    return rows.map((r) => r.timestamp);
  }

  /**
   * ¿Es de otra aula? Se mira a TODAS las aulas (acceso global sancionado:
   * con RLS el aula solo vería sus propios dominios), pero solo se contesta sí
   * o no: quién la tiene no sale de aquí.
   *
   * Cuenta como ocupada:
   *  - cualquier dominio de otra aula, también los de una suspendida o
   *    archivada y sus direcciones anteriores;
   *  - un dominio propio que sirve el SITIO público (no se convierte en el aula);
   *  - el `slug` de otra aula: es el subdominio con el que el plano de control
   *    la habría creado y por el que se la busca.
   */
  private async isTakenByOther(
    tenantId: string,
    label: string,
    hostname: string,
  ): Promise<boolean> {
    return runGlobalWithoutTenant(async () => {
      const [domain, tenantWithSlug] = await Promise.all([
        this.prisma.tenantDomain.findUnique({
          where: { hostname },
          select: { tenantId: true, surface: true },
        }),
        this.prisma.tenant.findFirst({
          where: { slug: label, NOT: { id: tenantId } },
          select: { id: true },
        }),
      ]);
      if (tenantWithSlug) return true;
      if (!domain) return false;
      return domain.tenantId !== tenantId || domain.surface !== 'APP';
    });
  }

  private buildState(
    suffix: string,
    hostname: string | null,
    recent: readonly Date[],
    now: Date,
  ): AcademyAddressState {
    const label = labelOf(hostname, suffix);
    const allowance = changeAllowance(recent, now);
    const blockedReason: AddressBlockedReason | null = !hostname
      ? 'no_address'
      : label === null
        ? 'own_domain'
        : allowance.left === 0
          ? 'limit'
          : null;
    return {
      suffix,
      hostname,
      label,
      canChange: blockedReason === null,
      blockedReason,
      maxChanges: MAX_ADDRESS_CHANGES,
      windowDays: ADDRESS_CHANGE_WINDOW_DAYS,
      changesLeft: allowance.left,
      nextChangeAt: allowance.nextChangeAt?.toISOString() ?? null,
    };
  }
}

function blocked(state: AcademyAddressState): ConflictException {
  switch (state.blockedReason) {
    case 'limit':
      return new ConflictException({
        message: `Ya has cambiado la dirección ${MAX_ADDRESS_CHANGES} veces en ${ADDRESS_CHANGE_WINDOW_DAYS} días.`,
        code: 'ACADEMY_ADDRESS_CHANGE_LIMIT',
      });
    case 'own_domain':
      return new ConflictException({
        message: 'El aula usa un dominio propio: su dirección no se cambia desde aquí.',
        code: 'ACADEMY_ADDRESS_OWN_DOMAIN',
      });
    default:
      return new ConflictException({
        message: 'El aula no tiene una dirección que cambiar.',
        code: 'ACADEMY_ADDRESS_NONE',
      });
  }
}

function unavailable(a: AddressAvailability): BadRequestException | ConflictException {
  switch (a.status) {
    case 'taken':
      return new ConflictException({
        message: 'Esa dirección ya la usa otra academia.',
        code: 'ACADEMY_ADDRESS_TAKEN',
      });
    case 'reserved':
      return new BadRequestException({
        message: 'Esa dirección está reservada.',
        code: 'ACADEMY_ADDRESS_RESERVED',
      });
    case 'current':
      return new BadRequestException({
        message: 'Esa ya es la dirección de tu academia.',
        code: 'ACADEMY_ADDRESS_UNCHANGED',
      });
    default:
      return new BadRequestException({
        message:
          'La dirección solo puede llevar letras minúsculas sin tilde, números y guiones, de 3 a 63 caracteres.',
        code: 'ACADEMY_ADDRESS_INVALID',
      });
  }
}
