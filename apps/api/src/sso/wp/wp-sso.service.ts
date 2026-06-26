import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { verifyWpSsoToken, WpSsoTokenError } from '@didacta/mod-wp-sso';
import IORedis, { type Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { TokenService } from '../../auth/token.service';

/**
 * WpSsoService — intercambia el token firmado por WordPress por una sesión
 * Didacta. Flujo (ver modules/wp-sso/README.md):
 *
 *   1. Verifica el token (firma HMAC, audiencia, issuer, exp, TTL máx) →
 *      mod.wp-sso `verifyWpSsoToken` (pura).
 *   2. Anti-replay: marca el `jti` como usado (Redis SET NX EX). Single-use.
 *   3. Resuelve el usuario por IDENTIDAD ESTABLE (`sub` = WordPress user_id) vía
 *      `UserExternalIdentity`. Si no hay vínculo, cae a email: lazy-link de la
 *      cuenta existente o auto-provisión (rol `alumno`) si está habilitada. Un
 *      token legacy 0.1.0 sin `sub` degrada a email-only con warning.
 *   4. Emite la sesión (TokenService) y devuelve tokens + datos del user.
 *
 * Config (V1, por env del host):
 *   - WP_SSO_SHARED_SECRET   (obligatorio) secreto HMAC compartido con WP.
 *   - WP_SSO_TENANT_SLUG     (obligatorio) tenant destino de los usuarios WP.
 *   - WP_SSO_ISSUER          (opcional) URL del WordPress origen — si se define,
 *                            el token debe declararla en `iss`.
 *   - WP_SSO_AUDIENCE        (opcional) audiencia esperada (default didacta-wp-sso).
 *   - WP_SSO_AUTOCREATE      (opcional, default 'true') auto-crea usuarios nuevos.
 */
@Injectable()
export class WpSsoService {
  private readonly logger = new Logger(WpSsoService.name);
  /** `undefined` = sin inicializar; `null` = sin Redis (fallback in-memory). */
  private redis?: Redis | null;
  /** Fallback anti-replay si no hay Redis (single-replica / dev). */
  private readonly usedJti = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  /** True si WP-SSO está configurado (secreto + tenant). Lo usa el endpoint de status. */
  isConfigured(): boolean {
    return Boolean(process.env['WP_SSO_SHARED_SECRET'] && process.env['WP_SSO_TENANT_SLUG']);
  }

  /**
   * Config pública (SIN secretos) que consume el signin para el auto-bounce
   * transparente:
   *   - configured:   hay secreto + tenant.
   *   - autoRedirect: `WP_SSO_AUTO_REDIRECT=true` → el signin rebota a WordPress
   *                   en modo `try` (silencioso) si no hay sesión Didacta.
   *   - wordpressUrl: `WP_SSO_ISSUER` (home_url de WP) — destino del bounce.
   */
  ssoConfig(): { configured: boolean; autoRedirect: boolean; wordpressUrl: string | null } {
    return {
      configured: this.isConfigured(),
      autoRedirect: process.env['WP_SSO_AUTO_REDIRECT'] === 'true',
      wordpressUrl: process.env['WP_SSO_ISSUER']?.trim().replace(/\/+$/, '') || null,
    };
  }

  async exchange(token: string): Promise<{
    tokens: { accessToken: string; refreshToken: string };
    user: {
      id: string;
      email: string;
      name: string | null;
      tenantId: string;
      tenantSlug: string;
      roles: string[];
    };
  }> {
    const sharedSecret = process.env['WP_SSO_SHARED_SECRET'] ?? '';
    const tenantSlug = process.env['WP_SSO_TENANT_SLUG'] ?? '';
    if (!sharedSecret || !tenantSlug) {
      throw new WpSsoTokenError(
        'not_configured',
        'WP-SSO no configurado: faltan WP_SSO_SHARED_SECRET y/o WP_SSO_TENANT_SLUG en el host.',
      );
    }

    const claims = await verifyWpSsoToken(token, {
      sharedSecret,
      expectedIssuer: process.env['WP_SSO_ISSUER'] || undefined,
      expectedAudience: process.env['WP_SSO_AUDIENCE'] || undefined,
    });

    // Anti-replay: el jti es de un solo uso.
    const fresh = await this.consumeJti(claims.jti, claims.exp);
    if (!fresh) {
      throw new WpSsoTokenError(
        'replayed',
        'Este enlace SSO ya fue usado. Vuelve a entrar desde WordPress.',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) {
      throw new WpSsoTokenError(
        'not_configured',
        `WP_SSO_TENANT_SLUG="${tenantSlug}" no corresponde a ningún tenant.`,
      );
    }

    const provider = 'wp';
    // Issuer de la identidad: el `iss` del token (home_url de WP), con fallback al
    // env configurado y, en último caso, una constante estable.
    const issuer = claims.iss ?? process.env['WP_SSO_ISSUER'] ?? 'wordpress';
    const autoCreate = (process.env['WP_SSO_AUTOCREATE'] ?? 'true') !== 'false';

    // 1) Resolución por IDENTIDAD ESTABLE (sub). Independiente del email: resiste
    //    cambios y reuso de email en WordPress. Solo si el plugin firmó `sub` (≥0.2.0).
    const identity = claims.subject
      ? await this.prisma.userExternalIdentity.findUnique({
          where: {
            tenantId_provider_issuer_externalId: {
              tenantId: tenant.id,
              provider,
              issuer,
              externalId: claims.subject,
            },
          },
        })
      : null;

    let user = identity ? await this.loadUserWithRoles(identity.userId) : null;
    let provisioned = false;

    if (user) {
      // Vino por identidad estable: validar estado.
      if (user.status !== 'ACTIVE') {
        throw new UnauthorizedException('Tu cuenta no está activa. Contacta al administrador.');
      }
    } else {
      // 2) Sin identidad → resolver por email (lazy-link o auto-provisión).
      user = await this.prisma.user.findUnique({
        where: { tenantId_email: { tenantId: tenant.id, email: claims.email } },
        include: { roles: { include: { role: true } } },
      });

      if (!user) {
        if (!autoCreate) {
          await this.auditLog.record({
            tenantId: tenant.id,
            actorId: null,
            action: 'sso.wp.callback.rejected',
            resourceType: 'wp_sso',
            resourceId: claims.jti.slice(0, 12),
            metadata: { reason: 'user_not_provisioned', email: claims.email },
          });
          throw new UnauthorizedException(
            'No tienes cuenta en Didacta. Pídele al administrador que te dé de alta.',
          );
        }
        user = await this.provisionUser(tenant.id, claims.email, claims.name ?? null);
        provisioned = true;
      } else if (user.status !== 'ACTIVE') {
        // Un PENDING (p.ej. esperando aprobación de inscripcion-miembros) NO entra
        // por SSO hasta su aprobación. Regla de coexistencia deseada.
        throw new UnauthorizedException('Tu cuenta no está activa. Contacta al administrador.');
      }
    }

    // Salvaguarda de tipado/lógica: a este punto siempre hay user (o lanzamos).
    if (!user) {
      throw new WpSsoTokenError('invalid', 'No se pudo resolver el usuario del token SSO.');
    }

    // 3) Persistir el VÍNCULO ESTABLE (solo si el token trae sub).
    if (claims.subject) {
      if (identity) {
        await this.prisma.userExternalIdentity.update({
          where: { id: identity.id },
          data: {
            lastSeenAt: new Date(),
            emailVerified: claims.emailVerified,
            emailAtLink: claims.email,
          },
        });
      } else {
        const linkMethod = provisioned ? 'auto_provision' : 'auto_email';
        await this.prisma.userExternalIdentity.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            provider,
            issuer,
            externalId: claims.subject,
            emailAtLink: claims.email,
            emailVerified: claims.emailVerified,
            linkMethod,
            lastSeenAt: new Date(),
          },
        });
        await this.auditLog.record({
          tenantId: tenant.id,
          actorId: user.id,
          action: provisioned ? 'sso.wp.user.provisioned' : 'sso.wp.account.linked',
          resourceType: 'user',
          resourceId: user.id,
          metadata: {
            email: claims.email,
            sub: claims.subject,
            issuer,
            emailVerified: claims.emailVerified,
            linkMethod,
          },
        });
      }
    } else if (provisioned) {
      // Token legacy 0.1.0 sin sub: provisión degradada a email-only (con warning).
      this.logger.warn(
        'WP-SSO: token sin `sub` (plugin legacy 0.1.0). Provisión por email sin vínculo estable; actualiza el plugin a ≥0.2.0.',
      );
      await this.auditLog.record({
        tenantId: tenant.id,
        actorId: user.id,
        action: 'sso.wp.user.provisioned',
        resourceType: 'user',
        resourceId: user.id,
        metadata: {
          email: claims.email,
          name: claims.name ?? null,
          iss: claims.iss ?? null,
          legacyNoSub: true,
        },
      });
    }

    // 4) Refrescar lastLogin + name (si vino y cambió). No pisamos el email canónico.
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(claims.name && claims.name !== user.name ? { name: claims.name } : {}),
      },
    });

    const roles = user.roles.map((r) => r.role.name);
    const tokens = await this.tokens.sign({
      sub: user.id,
      tenantId: tenant.id,
      roles,
      // WordPress ya autenticó al usuario; no exigimos MFA local adicional.
      mfaVerified: true,
    });

    await this.auditLog.record({
      tenantId: tenant.id,
      actorId: user.id,
      action: 'sso.wp.signin.success',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email: claims.email, iss: claims.iss ?? null },
    });

    return {
      tokens,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tenantId: tenant.id,
        tenantSlug,
        roles,
      },
    };
  }

  /** Crea el usuario con rol `alumno` (si existe el rol en el tenant). */
  private async provisionUser(tenantId: string, email: string, name: string | null) {
    const alumnoRole = await this.prisma.role.findFirst({
      where: { name: 'alumno' },
      select: { id: true },
    });
    return this.prisma.user.create({
      data: {
        tenantId,
        email,
        name: name ?? email.split('@')[0],
        status: 'ACTIVE',
        passwordHash: null,
        ...(alumnoRole ? { roles: { create: { roleId: alumnoRole.id } } } : {}),
      },
      include: { roles: { include: { role: true } } },
    });
  }

  /** Carga un user con sus roles (mismo include que el resto del flujo). */
  private loadUserWithRoles(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
  }

  /**
   * Marca `jti` como usado de forma atómica. Devuelve `true` si es la PRIMERA
   * vez (token válido), `false` si ya fue usado (replay). TTL = vida restante
   * del token + margen, para no acumular keys eternamente.
   */
  private async consumeJti(jti: string, exp: number): Promise<boolean> {
    const ttl = Math.max(5, exp - Math.floor(Date.now() / 1000) + 10);
    const redis = this.getRedis();
    if (redis) {
      const res = await redis.set(`wpsso:jti:${jti}`, '1', 'EX', ttl, 'NX');
      return res === 'OK';
    }
    // Fallback in-memory: solo seguro con una réplica. Limpiamos vencidos.
    const now = Date.now();
    for (const [k, v] of this.usedJti) if (v <= now) this.usedJti.delete(k);
    if (this.usedJti.has(jti)) return false;
    this.usedJti.set(jti, now + ttl * 1000);
    return true;
  }

  private getRedis(): Redis | null {
    if (this.redis !== undefined) return this.redis;
    const url = process.env['REDIS_URL'];
    if (!url) {
      this.logger.warn(
        'REDIS_URL ausente — anti-replay WP-SSO en modo in-memory (solo seguro con una réplica).',
      );
      this.redis = null;
      return null;
    }
    this.redis = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    return this.redis;
  }
}
