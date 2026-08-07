/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../modules/prisma-tenant-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { runAsTenant, runSanctionedGlobalAccess } from '../tenancy/tenant-context.storage';
import type { ClientContext } from './client-context';
import { isAdminMfaEnforced } from './mfa-config';
import { MfaPolicyService } from './mfa-policy/mfa-policy.service';
import { MfaRequiredByTenantPolicyError } from './mfa-policy/mfa-required-by-tenant-policy.error';
import { PasswordService } from './password.service';
import { SessionRegistryService } from './session-registry.service';
import { TokenService, type SignedTokens } from './token.service';
import type { SigninDto, SignupDto } from './dto';

export class AmbiguousTenantError extends UnauthorizedException {
  constructor(public readonly candidateSlugs: string[]) {
    super({
      message: 'Tu email pertenece a más de una organización. Indica cuál quieres usar.',
      candidateSlugs,
      code: 'AMBIGUOUS_TENANT',
    });
  }
}

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const NO_CLIENT_CONTEXT: ClientContext = { ip: null, userAgent: null };

/** Rol por defecto de un alta por signup (el mismo que asignan los flujos de registro). */
const DEFAULT_SIGNUP_ROLE = 'alumno';

/**
 * El registro público está CERRADO por defecto: en un despliegue real las altas
 * entran por flujos que asignan rol — invitación de admin, SSO o los módulos y
 * APIs de registro instalados. El signup abierto creaba usuarios ACTIVE sin rol
 * (JWT roles:[] → 403 en storage y compañía).
 *
 * Dos formas de reabrirlo (A3 de `work/migracion-env-a-panel.md`):
 *   - `AUTH_SIGNUP_ENABLED=true` (env): lo abre para TODOS los tenants de la
 *     instalación. Pensado para stacks de dev/E2E que fabrican usuarios de
 *     prueba — precedencia máxima, igual que el resto de env vars del operador.
 *   - `tenant_setting` scope `auth` key `signup` (`{ enabled: true }`): lo abre
 *     SOLO para ese tenant. Decisión de negocio del tenant (¿acepto altas
 *     públicas?), no del despliegue — encaja en `/admin/configuracion`.
 */
function isSignupEnabledByEnv(): boolean {
  return process.env['AUTH_SIGNUP_ENABLED'] === 'true';
}

/**
 * Aviso opcional emitido al cliente cuando la política MFA tenant-wide está
 * activa y el usuario aún está dentro del grace period. Permite al frontend
 * mostrar un banner "Configura MFA antes de DD/MM/YYYY" sin bloquear.
 */
export interface MfaRequiredSoon {
  /** Días totales de gracia que dio el admin. */
  gracePeriodDays: number;
  /** Timestamp ISO en el que vence el grace para este tenant. */
  expiresAt: string;
  /** URL relativa del flujo de setup MFA. */
  setupUrl: string;
}

export interface AuthResult {
  tokens: SignedTokens;
  mfaRequired: boolean;
  /**
   * Presente solo cuando la política tenant-wide está activa, la capability
   * EE `feat:mfa.enforcement` también, y el usuario aún tiene tiempo de
   * configurar MFA. El cliente lo usa para mostrar el aviso UX.
   */
  mfaRequiredSoon?: MfaRequiredSoon;
  user: {
    id: string;
    email: string;
    name: string | null;
    /** URL del avatar (https o ruta relativa de storage), o null. */
    avatarUrl: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
    /** True si la contraseña es temporal y debe cambiarse tras el login. */
    mustChangePassword: boolean;
    /**
     * Timestamp ISO en que el usuario completó el onboarding de primera vez,
     * o null si aún no lo completó. El shell autenticado lo usa para forzar
     * /onboarding antes de dejar entrar.
     */
    onboardingCompletedAt: string | null;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly mfaPolicy: MfaPolicyService,
    private readonly sessions: SessionRegistryService,
    private readonly tenantConfig: PrismaTenantConfigService,
  ) {}

  async signup(
    dto: SignupDto,
    ctx: ClientContext = NO_CLIENT_CONTEXT,
    resolvedTenantId?: string,
  ): Promise<AuthResult> {
    // El check por-tenant necesita el tenant resuelto, así que la
    // resolución pasa a ir SIEMPRE primero (antes solo se resolvía si el
    // gate global ya había dejado pasar). Igual que signin, un tenant no
    // identificable da 401 antes que nada.
    const tenant = await this.resolveTenantForRequest({
      explicitSlug: dto.tenantSlug,
      resolvedTenantId,
      email: dto.email,
    });
    if (!tenant) {
      throw new UnauthorizedException({
        message:
          'No pudimos identificar tu organización. Prueba desde el enlace que te dio el admin o pide ayuda.',
        code: 'AUTH_TENANT_UNRESOLVED',
      });
    }

    // RLS F2: el alta entera corre bajo el ALS del tenant resuelto — sin esto
    // (endpoint público, sin middleware con Authorization) cada query era un
    // hueco de contexto. El check de signup habilitado también corre acá
    // adentro: lee tenant_setting, que es tenant-scoped.
    return runAsTenant(
      tenant.id,
      async () => {
        if (!(await this.isSignupEnabledForTenant(tenant.id))) {
          throw new ForbiddenException({
            message: 'El registro público está deshabilitado. Pide acceso a tu organización.',
            code: 'AUTH_SIGNUP_DISABLED',
          });
        }
        return this.signupInTenant(tenant, dto, ctx);
      },
      { traceLabel: 'auth-signup' },
    );
  }

  private async isSignupEnabledForTenant(tenantId: string): Promise<boolean> {
    if (isSignupEnabledByEnv()) return true;
    const setting = await this.tenantConfig
      .get<{ enabled?: boolean }>(tenantId, 'auth', 'signup')
      .catch(() => undefined);
    return setting?.enabled === true;
  }

  private async signupInTenant(
    tenant: { id: string; slug: string },
    dto: SignupDto,
    ctx: ClientContext,
  ): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: dto.email } },
    });
    if (existing) {
      throw new ConflictException({
        message: 'El email ya está registrado en este tenant',
        code: 'AUTH_EMAIL_TAKEN',
      });
    }

    const passwordHash = await this.passwords.hash(dto.password);
    // Rol por defecto en el alta: sin él, el usuario quedaba ACTIVE con JWT
    // roles:[] y 403 en todo lo que exige rol (causa raíz del bug de usuarios
    // sin rol). Mismo rol y mismo patrón que el resto de flujos de registro.
    const defaultRole = await this.prisma.role.findUnique({
      where: { name: DEFAULT_SIGNUP_ROLE },
    });
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: dto.email,
          name: dto.name ?? null,
          passwordHash,
          status: 'ACTIVE',
        },
        include: {
          roles: { include: { role: true } },
          tenant: true,
        },
      });
      if (defaultRole) {
        await tx.userRole.create({ data: { userId: created.id, roleId: defaultRole.id } });
      }
      return created;
    });

    const roles = defaultRole ? [defaultRole.name] : [];
    const mfaRequired = this.shouldRequireMfa(roles, user.mfaEnabled);

    // En signup el usuario se acaba de crear sin MFA. Si la política
    // tenant-wide está activa, NUNCA bloqueamos en signup (el grace acaba
    // de empezar para él), pero pasamos el aviso al cliente para que pueda
    // mostrar el banner de "configura MFA en N días". `evaluateLoginPolicy`
    // ya devuelve allow/warn (nunca block) si el usuario está dentro del
    // grace, así que aprovechamos la misma lógica.
    const policyOutcome = await this.mfaPolicy.evaluateLoginPolicy(tenant.id, {
      mfaEnabled: user.mfaEnabled,
      roles,
    });

    const tokens = await this.sessions.issue(
      {
        sub: user.id,
        tenantId: tenant.id,
        roles,
        mfaVerified: !mfaRequired,
      },
      ctx,
    );

    await this.auditLog.record({
      tenantId: tenant.id,
      actorId: user.id,
      action: 'user.signup',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email: user.email, tenantSlug: tenant.slug },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return {
      tokens,
      mfaRequired,
      ...(policyOutcome.outcome === 'warn'
        ? {
            mfaRequiredSoon: {
              gracePeriodDays: policyOutcome.gracePeriodDays,
              expiresAt: policyOutcome.gracePeriodExpiresAt,
              setupUrl: policyOutcome.setupUrl,
            },
          }
        : {}),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl ?? null,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        roles,
        mfaEnabled: user.mfaEnabled,
        mustChangePassword: user.mustChangePassword,
        onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
      },
    };
  }

  async signin(
    dto: SigninDto,
    ctx: ClientContext = NO_CLIENT_CONTEXT,
    resolvedTenantId?: string,
  ): Promise<AuthResult> {
    const tenant = await this.resolveTenantForRequest({
      explicitSlug: dto.tenantSlug,
      resolvedTenantId,
      email: dto.email,
    });
    if (!tenant) {
      throw new UnauthorizedException({
        message: 'Credenciales inválidas',
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    }

    // RLS F2: mismo racional que en signup.
    return runAsTenant(tenant.id, () => this.signinInTenant(tenant, dto, ctx), {
      traceLabel: 'auth-signin',
    });
  }

  private async signinInTenant(
    tenant: { id: string; slug: string },
    dto: SigninDto,
    ctx: ClientContext,
  ): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: dto.email } },
      include: { roles: { include: { role: true } }, tenant: true },
    });
    if (!user || !user.passwordHash || user.status !== 'ACTIVE') {
      await this.auditLog.record({
        tenantId: tenant.id,
        actorId: null,
        action: 'user.signin.failed',
        resourceType: 'user',
        resourceId: dto.email,
        metadata: { reason: 'user_not_found_or_inactive', tenantSlug: tenant.slug },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
      throw new UnauthorizedException({
        message: 'Credenciales inválidas',
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.auditLog.record({
        tenantId: tenant.id,
        actorId: user.id,
        action: 'user.signin.failed',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { reason: 'invalid_password' },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
      throw new UnauthorizedException({
        message: 'Credenciales inválidas',
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const roles = user.roles.map((r: { role: { name: string } }) => r.role.name);
    const mfaRequired = this.shouldRequireMfa(roles, user.mfaEnabled);

    // Política MFA tenant-wide (capability EE `feat:mfa.enforcement`).
    // Los admins ya están cubiertos por LMS-109 (mfaRequired arriba). Esta
    // evaluación afecta al resto del tenant y SOLO actúa si la licencia EE
    // está activa — el service hace el failsafe internamente.
    const policyOutcome = await this.mfaPolicy.evaluateLoginPolicy(tenant.id, {
      mfaEnabled: user.mfaEnabled,
      roles,
    });
    if (policyOutcome.outcome === 'block') {
      await this.auditLog.record({
        tenantId: tenant.id,
        actorId: user.id,
        action: 'user.signin.blocked_by_mfa_policy',
        resourceType: 'user',
        resourceId: user.id,
        metadata: {
          gracePeriodDays: policyOutcome.gracePeriodDays,
          gracePeriodExpiredAt: policyOutcome.gracePeriodExpiredAt,
        },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
      throw new MfaRequiredByTenantPolicyError({
        gracePeriodDays: policyOutcome.gracePeriodDays,
        gracePeriodExpiredAt: policyOutcome.gracePeriodExpiredAt,
        setupUrl: policyOutcome.setupUrl,
      });
    }

    const tokens = await this.sessions.issue(
      {
        sub: user.id,
        tenantId: tenant.id,
        roles,
        mfaVerified: !mfaRequired,
      },
      ctx,
    );

    await this.auditLog.record({
      tenantId: tenant.id,
      actorId: user.id,
      action: 'user.signin.success',
      resourceType: 'user',
      resourceId: user.id,
      metadata: {
        mfaRequired,
        roles,
        ...(policyOutcome.outcome === 'warn' ? { mfaPolicyGraceWarning: true } : {}),
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return {
      tokens,
      mfaRequired,
      ...(policyOutcome.outcome === 'warn'
        ? {
            mfaRequiredSoon: {
              gracePeriodDays: policyOutcome.gracePeriodDays,
              expiresAt: policyOutcome.gracePeriodExpiresAt,
              setupUrl: policyOutcome.setupUrl,
            },
          }
        : {}),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl ?? null,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        roles,
        mfaEnabled: user.mfaEnabled,
        mustChangePassword: user.mustChangePassword,
        onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
      },
    };
  }

  async refresh(
    refreshToken: string,
    ctx: ClientContext = NO_CLIENT_CONTEXT,
  ): Promise<SignedTokens> {
    const claims = await this.tokens.verifyRefresh(refreshToken).catch(() => null);
    if (!claims) {
      throw new UnauthorizedException({
        message: 'Refresh token inválido o expirado',
        code: 'AUTH_REFRESH_TOKEN_INVALID',
      });
    }
    // RLS F2: lookup por id de usuario ANTES de conocer el tenant — acceso
    // global sancionado (inventario del flip F3).
    const user = await runSanctionedGlobalAccess(() =>
      this.prisma.user.findUnique({
        where: { id: claims.sub },
        include: { roles: { include: { role: true } } },
      }),
    );
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        message: 'Usuario no válido',
        code: 'AUTH_USER_INVALID',
      });
    }
    const roles = user.roles.map((r: { role: { name: string } }) => r.role.name);
    // Rotar y no re-emitir: si cada refresh abriera una sesión nueva, la lista
    // de «sesiones activas» del usuario acumularía una fila por hora.
    return runAsTenant(
      user.tenantId,
      () =>
        this.sessions.rotate(
          claims.sid,
          {
            sub: user.id,
            tenantId: user.tenantId,
            roles,
            mfaVerified: !this.shouldRequireMfa(roles, user.mfaEnabled),
          },
          ctx,
        ),
      { traceLabel: 'auth-refresh', userId: user.id },
    );
  }

  /**
   * Política global de MFA por rol. **Default = NO obligatorio.**
   *
   * El operador puede activar enforcement automática para roles admin
   * con `DIDACTA_REQUIRE_MFA_ADMIN=true` (ver `mfa-config.ts` para los
   * valores aceptados). Sin la env var, los admins NO son redirigidos
   * automáticamente a `/mfa/setup` — pueden configurar MFA opcionalmente
   * desde su perfil de seguridad.
   *
   * NOTA: la política tenant-wide (`feat:mfa.enforcement`) sigue activa
   * con su propio flujo (`MfaPolicyService`). Si el tenant_admin la
   * habilita en `/admin/seguridad`, los usuarios reciben el aviso
   * `mfaRequiredSoon` independientemente del valor de esta env var.
   *
   * - Si no configuró MFA: hay que forzar setup en primer login.
   * - Si ya lo configuró: hay que pedir el segundo factor en runtime.
   * En ambos casos, mfaRequired=true. mfaEnabled solo cambia el flujo
   * (setup vs verify), no si se exige o no.
   */
  shouldRequireMfa(roles: readonly string[], _mfaEnabled: boolean): boolean {
    if (!isAdminMfaEnforced()) return false;
    return roles.some((r) => ADMIN_ROLES.has(r));
  }

  /**
   * Resuelve el tenant del request siguiendo HU-SA-001 + LMS-110:
   *   1. Si el caller pasó un `resolvedTenantId` (resuelto del Host header
   *      por el controller), úsalo si está activo.
   *   2. Si el body trae `explicitSlug` (legacy / link de invitación), úsalo.
   *   3. Si no, fallback email-first: buscar el email entre tenants ACTIVE.
   *      - Match único: usar ese tenant.
   *      - Match múltiple: throw AmbiguousTenantError con la lista.
   *      - Sin match: null (el caller decide cómo responder).
   */
  private async resolveTenantForRequest(args: {
    explicitSlug?: string;
    resolvedTenantId?: string;
    email: string;
  }) {
    if (args.resolvedTenantId) {
      const t = await this.prisma.tenant.findUnique({
        where: { id: args.resolvedTenantId },
      });
      if (t && t.status === 'ACTIVE') return t;
    }

    if (args.explicitSlug) {
      const t = await this.prisma.tenant.findUnique({
        where: { slug: args.explicitSlug },
      });
      if (t && t.status === 'ACTIVE') return t;
      return null;
    }

    // Fallback email-first: ¿este email existe en uno o varios tenants?
    // Lookup cross-tenant DELIBERADO (aún no sabemos el tenant): sancionado.
    const matches = await runSanctionedGlobalAccess(() =>
      this.prisma.user.findMany({
        where: {
          email: args.email,
          deletedAt: null,
          status: 'ACTIVE',
          tenant: { status: 'ACTIVE' },
        },
        include: { tenant: true },
        take: 5,
      }),
    );

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0]!.tenant;

    throw new AmbiguousTenantError(matches.map((m) => m.tenant.slug));
  }
}
