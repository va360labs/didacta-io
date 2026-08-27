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

  async resolveByHost(host: string | undefined): Promise<ResolvedTenant | null> {
    if (!host) return null;
    const hostname = this.normalize(host);
    if (!hostname) return null;

    // Bootstrap host→tenant: por definición corre ANTES de conocer el tenant,
    // así que es un acceso global sancionado (en el flip RLS pasará por
    // didacta_super o por una policy de SELECT propia en tenant_domain).
    const domain = await runSanctionedGlobalAccess(() =>
      this.prisma.tenantDomain.findFirst({
        where: { hostname, isVerified: true },
        include: { tenant: true },
      }),
    );

    if (!domain || domain.tenant.status !== 'ACTIVE') return null;

    return {
      id: domain.tenant.id,
      slug: domain.tenant.slug,
      name: domain.tenant.name,
      matchedBy: 'hostname',
      hostname,
      surface: domain.surface,
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
