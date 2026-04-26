import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
  /** Match exacto por hostname (resuelto via tenant_domain). */
  matchedBy: 'hostname';
  hostname: string;
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

    const domain = await this.prisma.tenantDomain.findFirst({
      where: { hostname, isVerified: true },
      include: { tenant: true },
    });

    if (!domain || domain.tenant.status !== 'ACTIVE') return null;

    return {
      id: domain.tenant.id,
      slug: domain.tenant.slug,
      name: domain.tenant.name,
      matchedBy: 'hostname',
      hostname,
    };
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
