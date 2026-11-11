/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import type { TenantDomainSurface } from '@didacta/database';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePublicHost } from '../common/resolve-public-host';
import { runAsTenant, runSanctionedGlobalAccess } from './tenant-context.storage';
import {
  resolveWebBaseUrl,
  resolveWebBaseUrlForAuthRedirect,
  type RequestLike,
} from '../common/resolve-web-base-url';

export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
  /** Match exacto por hostname (resuelto via tenant_domain). */
  matchedBy: 'hostname';
  hostname: string;
  /**
   * Qué sirve el dominio por el que se resolvió: la app del aula o el sitio
   * público. Solo lo llenan `resolveByHost`/`resolveByRequest`, que son los que
   * miran un dominio; resolver por slug no pasa por ninguno.
   */
  surface?: TenantDomainSurface;
}

/**
 * Lo que se sabe de un hostname. Tres respuestas, no dos:
 *
 *  - `active`: es de un tenant en marcha; se sirve.
 *  - `suspended`: es de un tenant que EXISTE pero está suspendido.
 *  - `unknown`: no es de nadie (o es de un tenant archivado, que para un
 *    visitante es lo mismo: ahí ya no hay nada).
 *
 * `suspended` no lleva al tenant a propósito: ni id, ni slug, ni nombre. Quien
 * llega a un aula suspendida solo tiene que saber eso, y un tipo sin los campos
 * es la forma de que ningún caller los pueda filtrar por descuido.
 */
export type HostResolution =
  | { status: 'active'; tenant: ResolvedTenant }
  | { status: 'suspended' }
  | { status: 'unknown' };

/**
 * Resuelve el tenant del request a partir del Host header.
 *
 * Estrategia:
 *  - Normaliza el host (lowercase, sin puerto, sin trailing dot).
 *  - Busca match exacto en `tenant_domain` (verified-only).
 *  - Si no hay match, devuelve null (el caller decide qué hacer:
 *    fallback email-only, pedir tenantSlug explícito, etc.).
 *
 * Decisión: NO hacemos match por wildcard de subdominio acá. Cada
 * subdominio se siembra explícitamente para evitar phishing-like
 * (ej. `evil.didacta.com` no debería resolver a `didacta`). Custom
 * domains de tenants pasan por verificación DNS antes de marcarse
 * `is_verified=true`.
 */
@Injectable()
export class TenantResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resuelve el host a un tenant ACTIVO, o null.
   *
   * Es la puerta de todo lo que sirve un tenant (login, alta, checkout,
   * webhooks, contexto del sitio): un tenant suspendido NO pasa por aquí, y eso
   * es lo que impide iniciar sesión en él. Quien necesite distinguir «no es de
   * nadie» de «está suspendido» —hoy, solo la página de aula suspendida— usa
   * `resolveHostStatus`.
   */
  async resolveByHost(host: string | undefined): Promise<ResolvedTenant | null> {
    const resolution = await this.resolveHostStatus(host);
    return resolution.status === 'active' ? resolution.tenant : null;
  }

  /**
   * Igual que `resolveByHost`, pero sin tragarse la diferencia entre un host
   * desconocido y el de un tenant suspendido.
   *
   * Antes las dos cosas eran `null`, así que la web contestaba «Not Found» en
   * el aula de un cliente con la suscripción vencida: parecía que el producto
   * se había caído o que el dominio estaba mal, y nadie le decía que lo que
   * tenía que hacer era revisar su suscripción.
   */
  async resolveHostStatus(host: string | undefined): Promise<HostResolution> {
    if (!host) return { status: 'unknown' };
    const hostname = this.normalize(host);
    if (!hostname) return { status: 'unknown' };

    // Bootstrap host→tenant: por definición corre ANTES de conocer el tenant,
    // así que es un acceso global sancionado (en el flip RLS pasará por
    // didacta_super o por una policy de SELECT propia en tenant_domain).
    const domain = await runSanctionedGlobalAccess(() =>
      this.prisma.tenantDomain.findFirst({
        where: { hostname, isVerified: true },
        include: { tenant: true },
      }),
    );

    if (!domain) return { status: 'unknown' };
    if (domain.tenant.status === 'SUSPENDED') return { status: 'suspended' };
    // ARCHIVED (o cualquier estado futuro que no sea ACTIVE): desconocido.
    if (domain.tenant.status !== 'ACTIVE') return { status: 'unknown' };

    return {
      status: 'active',
      tenant: {
        id: domain.tenant.id,
        slug: domain.tenant.slug,
        name: domain.tenant.name,
        matchedBy: 'hostname',
        hostname,
        surface: domain.surface,
      },
    };
  }

  /**
   * Resuelve el tenant de una petición leyendo su host público.
   *
   * Azúcar sobre `resolveByHost(resolvePublicHost(req))`, para que el caller no
   * tenga que acordarse de CUÁL de las dos cabeceras es la buena — que es justo
   * el despiste que dejó toda la multi-tenencia resolviendo a `localhost`.
   *
   * Deliberadamente **sin respaldo al host interno**. Es tentador: una
   * instalación sembrada con el `BOOTSTRAP_DOMAINS` por defecto solo tiene
   * `localhost` en `tenant_domain`, y caer a él la haría "funcionar". Pero
   * `localhost` pertenece a un tenant concreto, así que ese respaldo haría que
   * CUALQUIER hostname resolviera a ese tenant — es exactamente el agujero de
   * UC-C403 AC2, donde un subdominio sin asignar servía un aula ajena. Que un
   * dominio que falta se note como 404 es la respuesta correcta: se arregla
   * añadiendo la fila, no adivinando.
   */
  async resolveByRequest(req: RequestLike): Promise<ResolvedTenant | null> {
    return this.resolveByHost(resolvePublicHost(req));
  }

  /** `resolveHostStatus` sobre el host público de la petición. */
  async resolveHostStatusByRequest(req: RequestLike): Promise<HostResolution> {
    return this.resolveHostStatus(resolvePublicHost(req));
  }

  /**
   * Resuelve por slug explícito (path `/t/:slug` o body de signin compat).
   * Devuelve solo si el tenant está ACTIVE.
   */
  async resolveBySlug(slug: string): Promise<ResolvedTenant | null> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.status !== 'ACTIVE') return null;
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      matchedBy: 'hostname',
      hostname: '',
    };
  }

  /**
   * Sentido inverso de `resolveByHost`: dado un tenant, su dominio primario
   * verificado (`TenantDomain.isPrimary && isVerified`), si tiene uno. El
   * tenant ya es conocido por el caller, así que la query corre escopada con
   * `runAsTenant` (RLS estándar), no sancionada.
   */
  async resolvePrimaryDomain(tenantId: string): Promise<string | null> {
    const domain = await runAsTenant(tenantId, () =>
      this.prisma.tenantDomain.findFirst({
        where: { tenantId, isPrimary: true, isVerified: true },
      }),
    );
    return domain?.hostname ?? null;
  }

  /**
   * `resolveWebBaseUrl` consciente del tenant: si `tenantId` es conocido,
   * intenta primero su dominio primario verificado antes de derivar del Host
   * del request. `tenantId: null` es un no-op explícito (p.ej. el tenant
   * todavía no existe, o el token que trajo la request es opaco) — cae
   * directo al comportamiento de siempre.
   */
  async resolveTenantWebBaseUrl(tenantId: string | null, req?: RequestLike): Promise<string> {
    const hostname = tenantId ? await this.resolvePrimaryDomain(tenantId) : null;
    return resolveWebBaseUrl(req, hostname);
  }

  /** Variante endurecida (ver `resolveWebBaseUrlForAuthRedirect`) consciente del tenant. */
  async resolveTenantWebBaseUrlForAuthRedirect(
    tenantId: string | null,
    req?: RequestLike,
  ): Promise<string> {
    const hostname = tenantId ? await this.resolvePrimaryDomain(tenantId) : null;
    return resolveWebBaseUrlForAuthRedirect(req, hostname);
  }

  /** Normaliza host: lowercase, sin puerto, sin trailing dot. */
  private normalize(rawHost: string): string {
    let h = rawHost.trim().toLowerCase();
    // Eliminar puerto.
    const colonIdx = h.lastIndexOf(':');
    if (colonIdx > -1 && h.indexOf(']') === -1) {
      // No es IPv6 entre brackets; cortar puerto.
      h = h.slice(0, colonIdx);
    }
    // Eliminar trailing dot (FQDN).
    if (h.endsWith('.')) h = h.slice(0, -1);
    return h;
  }
}
