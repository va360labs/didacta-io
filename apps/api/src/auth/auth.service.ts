import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ClientContext } from './client-context';
import { PasswordService } from './password.service';
import { TokenService, type SignedTokens } from './token.service';
import type { SigninDto, SignupDto } from './dto';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const NO_CLIENT_CONTEXT: ClientContext = { ip: null, userAgent: null };

export interface AuthResult {
  tokens: SignedTokens;
  mfaRequired: boolean;
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
  ) {}

  async signup(dto: SignupDto, ctx: ClientContext = NO_CLIENT_CONTEXT): Promise<AuthResult> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new UnauthorizedException('Tenant no válido o no activo');
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

  async signin(dto: SigninDto, ctx: ClientContext = NO_CLIENT_CONTEXT): Promise<AuthResult> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') {
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
      metadata: { mfaRequired, roles },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return {
      tokens,
      mfaRequired,
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
   * Roles administrativos exigen MFA según FR-CORE-02.
   * - Si no configuró MFA: hay que forzar setup en primer login.
   * - Si ya lo configuró: hay que pedir el segundo factor en runtime.
   * En ambos casos, mfaRequired=true. mfaEnabled solo cambia el flujo
   * (setup vs verify), no si se exige o no.
   */
  shouldRequireMfa(roles: readonly string[], _mfaEnabled: boolean): boolean {
    return roles.some((r) => ADMIN_ROLES.has(r));
  }
}
