import { ConflictException, Injectable } from '@nestjs/common';
import type { ClientContext } from '../auth/client-context';
import { PasswordService } from '../auth/password.service';
import { TokenService, type SignedTokens } from '../auth/token.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SetupInitDto } from './dto';

const NO_CTX: ClientContext = { ip: null, userAgent: null };

const SYSTEM_ROLES = [
  { name: 'super_admin', description: 'Acceso global a la plataforma' },
  { name: 'tenant_admin', description: 'Gestor de un tenant' },
  { name: 'formador', description: 'Crea y mantiene cursos' },
  { name: 'alumno', description: 'Consume cursos y se matricula' },
  { name: 'auditor', description: 'Acceso de solo lectura para auditoría' },
  { name: 'empresa_manager', description: 'RRHH de empresa bonificada' },
] as const;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOSTNAME_RE = /^[a-z0-9.-]{1,253}$/;

export interface SetupStatus {
  initialized: boolean;
}

export interface SetupInitResult {
  tokens: SignedTokens;
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

/**
 * Bootstrap de primer arranque.
 *
 * El endpoint público `/setup/init` solo funciona si la instancia está virgen
 * (cero tenants `ACTIVE` o `SUSPENDED`). Una vez creado el primer tenant la
 * llamada queda permanentemente cerrada con 409, porque los tenants nunca se
 * borran físicamente (solo `deletedAt`). Esto permite exponer el endpoint sin
 * autenticación sin abrir un vector de toma de control.
 *
 * Reemplaza al script `seed.ts` para escenarios self-host donde el operador
 * arranca el contenedor sin envs `BOOTSTRAP_*` y configura por UI.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  async getStatus(): Promise<SetupStatus> {
    const count = await this.prisma.tenant.count({ where: { deletedAt: null } });
    return { initialized: count > 0 };
  }

  async init(
    dto: SetupInitDto,
    requestHostname: string | null,
    ctx: ClientContext = NO_CTX,
  ): Promise<SetupInitResult> {
    const slug = (dto.organization.slug ?? this.slugify(dto.organization.name)).toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new ConflictException(
        'No pudimos generar un slug válido a partir del nombre. Indicá uno manualmente (minúsculas, números, guiones).',
      );
    }
    const hostname = (dto.organization.primaryHostname ?? requestHostname ?? 'localhost')
      .trim()
      .toLowerCase();
    if (!HOSTNAME_RE.test(hostname)) {
      throw new ConflictException('Hostname inválido.');
    }

    const passwordHash = await this.passwords.hash(dto.admin.password);

    // Transacción única: re-chequea el "first run" DENTRO para cerrar la
    // ventana de carrera entre dos POST /setup/init concurrentes.
    const created = await this.prisma.$transaction(async (tx) => {
      const tenantsCount = await tx.tenant.count({ where: { deletedAt: null } });
      if (tenantsCount > 0) {
        throw new ConflictException({
          code: 'ALREADY_INITIALIZED',
          message: 'La plataforma ya fue inicializada. Iniciá sesión con tu cuenta admin.',
        });
      }

      // 1. Roles del sistema (idempotente: si el seed corrió antes, upsert).
      for (const role of SYSTEM_ROLES) {
        await tx.role.upsert({
          where: { name: role.name },
          update: { description: role.description, isSystem: true },
          create: { name: role.name, description: role.description, isSystem: true },
        });
      }
      const superAdminRole = await tx.role.findUniqueOrThrow({ where: { name: 'super_admin' } });

      // 2. Tenant + dominio primario verificado.
      const tenant = await tx.tenant.create({
        data: { slug, name: dto.organization.name, status: 'ACTIVE' },
      });
      await tx.tenantDomain.create({
        data: {
          tenantId: tenant.id,
          hostname,
          isPrimary: true,
          isVerified: true,
        },
      });
      // Sembramos también `localhost` para que el operador pueda probar la
      // misma instalación desde el túnel SSH o `docker compose up` local sin
      // tener que añadir un dominio extra desde /admin.
      if (hostname !== 'localhost') {
        await tx.tenantDomain.upsert({
          where: { hostname: 'localhost' },
          update: {},
          create: {
            tenantId: tenant.id,
            hostname: 'localhost',
            isPrimary: false,
            isVerified: true,
          },
        });
      }

      // 3. Usuario super_admin con password seteado inline.
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: dto.admin.email,
          name: dto.admin.name,
          passwordHash,
          status: 'ACTIVE',
        },
      });
      await tx.userRole.create({
        data: { userId: user.id, roleId: superAdminRole.id },
      });

      return { tenant, user };
    });

    await this.auditLog.record({
      tenantId: created.tenant.id,
      actorId: created.user.id,
      action: 'setup.initialized',
      resourceType: 'tenant',
      resourceId: created.tenant.id,
      metadata: {
        slug: created.tenant.slug,
        primaryHostname: hostname,
        adminEmail: created.user.email,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    const roles = ['super_admin'];
    const tokens = await this.tokens.sign({
      sub: created.user.id,
      tenantId: created.tenant.id,
      roles,
      // El primer admin entra con MFA verificado=true para no bloquearse a sí
      // mismo: no hay otro admin que pueda resetearle MFA si pierde el factor.
      // Puede activarlo después desde /cuenta/mfa cuando le venga bien.
      mfaVerified: true,
    });

    return {
      tokens,
      user: {
        id: created.user.id,
        email: created.user.email,
        name: created.user.name,
        tenantId: created.tenant.id,
        tenantSlug: created.tenant.slug,
        roles,
        mfaEnabled: false,
      },
    };
  }

  private slugify(name: string): string {
    return name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);
  }
}
