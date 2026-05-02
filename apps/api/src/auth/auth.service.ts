import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ClientContext } from './client-context';
import { isAdminMfaEnforced } from './mfa-config';
import { MfaPolicyService } from './mfa-policy/mfa-policy.service';
import { MfaRequiredByTenantPolicyError } from './mfa-policy/mfa-required-by-tenant-policy.error';
import { PasswordService } from './password.service';
import { TokenService, type SignedTokens } from './token.service';
import type { SigninDto, SignupDto } from './dto';

export class AmbiguousTenantError extends UnauthorizedException {
  constructor(public readonly candidateSlugs: string[]) {
    super({
      message: 'Tu email pertenece a más de una organización. Indicá cuál querés usar.',
      candidateSlugs,
      code: 'AMBIGUOUS_TENANT',
    });
  }
}

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const NO_CLIENT_CONTEXT: ClientContext = { ip: null, userAgent: null };

/**
 * Aviso opcional emitido al cliente cuando la política MFA tenant-wide está
 * activa y el usuario aún está dentro del grace period. Permite al frontend
 * mostrar un banner "Configurá MFA antes de DD/MM/YYYY" sin bloquear.
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
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
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
  ) {}

  async signup(
    dto: SignupDto,
    ctx: ClientContext = NO_CLIENT_CONTEXT,
    resolvedTenantId?: string,
  ): Promise<AuthResult> {
    const tenant = await this.resolveTenantForRequest({
      explicitSlug: dto.tenantSlug,
      resolvedTenantId,
      email: dto.email,
    });
    if (!tenant) {
      throw new UnauthorizedException(
        'No pudimos identificar tu organización. Probá desde el enlace que te dio el admin o pedí ayuda.',
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: dto.email } },
    });
    if (existing) {
      throw new ConflictException('El email ya está registrado en este tenant');
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.prisma.user.create({
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

    const roles = user.roles.map((r: { role: { name: string } }) => r.role.name);
    const mfaRequired = this.shouldRequireMfa(roles, user.mfaEnabled);

    // En signup el usuario se acaba de crear sin MFA. Si la política
    // tenant-wide está activa, NUNCA bloqueamos en signup (el grace acaba
    // de empezar para él), pero pasamos el aviso al cliente para que pueda
    // mostrar el banner de "configurá MFA en N días". `evaluateLoginPolicy`
    // ya devuelve allow/warn (nunca block) si el usuario está dentro del
    // grace, así que aprovechamos la misma lógica.
    const policyOutcome = await this.mfaPolicy.evaluateLoginPolicy(tenant.id, {
      mfaEnabled: user.mfaEnabled,
      roles,
    });

    const tokens = await this.tokens.sign({
      sub: user.id,
      tenantId: tenant.id,
      roles,
      mfaVerified: !mfaRequired,
    });

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
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        roles,
        mfaEnabled: user.mfaEnabled,
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
      throw new UnauthorizedException('Credenciales inválidas');
    }

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
      throw new UnauthorizedException('Credenciales inválidas');
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
      throw new UnauthorizedException('Credenciales inválidas');
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

    const tokens = await this.tokens.sign({
      sub: user.id,
      tenantId: tenant.id,
      roles,
      mfaVerified: !mfaRequired,
    });

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
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        roles,
        mfaEnabled: user.mfaEnabled,
      },
    };
  }

  async refresh(refreshToken: string): Promise<SignedTokens> {
    const claims = await this.tokens.verifyRefresh(refreshToken).catch(() => null);
    if (!claims) {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      include: { roles: { include: { role: true } } },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Usuario no válido');
    }
    const roles = user.roles.map((r: { role: { name: string } }) => r.role.name);
    return this.tokens.sign({
      sub: user.id,
      tenantId: user.tenantId,
      roles,
      mfaVerified: !this.shouldRequireMfa(roles, user.mfaEnabled),
    });
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
    const matches = await this.prisma.user.findMany({
      where: {
        email: args.email,
        deletedAt: null,
        status: 'ACTIVE',
        tenant: { status: 'ACTIVE' },
      },
      include: { tenant: true },
      take: 5,
    });

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0]!.tenant;

    throw new AmbiguousTenantError(matches.map((m) => m.tenant.slug));
  }
}
