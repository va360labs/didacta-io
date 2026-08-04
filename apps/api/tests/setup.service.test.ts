import { sessionRegistryStub } from './helpers/session-registry-stub';
/**
 * Tests unit de SetupService — bootstrap del primer arranque.
 *
 * El servicio orquesta una transacción Prisma con varias escrituras encadenadas.
 * Usamos un fake de Prisma con estado in-memory que reproduce la semántica
 * `$transaction(cb) → cb(tx)` y los upsert/create por tabla. Esto nos permite
 * verificar contratos sin requerir Postgres y sin mocks frágiles.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { SetupService } from '../src/setup/setup.service';
import { PasswordService } from '../src/auth/password.service';

// `new PasswordService()` (a nivel módulo, abajo) carga loadAuthConfig() en su
// constructor, que exige AUTH_SECRET >= 32 chars. vitest no carga apps/api/.env,
// así que lo fijamos aquí (mismo patrón que jwt-guard.test.ts).
process.env['AUTH_SECRET'] = process.env['AUTH_SECRET'] ?? 'a'.repeat(64);

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  deletedAt: Date | null;
}
interface RoleRow {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
}
interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
}
interface UserRoleRow {
  userId: string;
  roleId: string;
}
interface TenantDomainRow {
  id: string;
  tenantId: string;
  hostname: string;
  isPrimary: boolean;
  isVerified: boolean;
}
interface AuditLogRow {
  id: number;
  tenantId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  hash: string;
  prevHash: string | null;
  createdAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

function makeFakePrisma() {
  const state = {
    tenants: [] as TenantRow[],
    roles: [] as RoleRow[],
    users: [] as UserRow[],
    userRoles: [] as UserRoleRow[],
    tenantDomains: [] as TenantDomainRow[],
    auditLogs: [] as AuditLogRow[],
    seq: 1,
  };

  const id = (prefix: string) => `${prefix}-${state.seq++}`;

  const client = {
    tenant: {
      count: vi.fn(async ({ where }: { where?: { deletedAt?: null } } = {}) => {
        return state.tenants.filter((t) =>
          where?.deletedAt === null ? t.deletedAt === null : true,
        ).length;
      }),
      create: vi.fn(async ({ data }: { data: Omit<TenantRow, 'id' | 'deletedAt'> }) => {
        const row: TenantRow = { id: id('tenant'), deletedAt: null, ...data };
        state.tenants.push(row);
        return row;
      }),
    },
    role: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { name: string };
          create: { name: string; description: string; isSystem: boolean };
          update: { description: string; isSystem: boolean };
        }) => {
          const existing = state.roles.find((r) => r.name === where.name);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const row: RoleRow = { id: id('role'), ...create };
          state.roles.push(row);
          return row;
        },
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { name: string } }) => {
        const r = state.roles.find((x) => x.name === where.name);
        if (!r) throw new Error(`role ${where.name} not found`);
        return r;
      }),
    },
    user: {
      create: vi.fn(async ({ data }: { data: Omit<UserRow, 'id'> }) => {
        const row: UserRow = { id: id('user'), ...data };
        state.users.push(row);
        return row;
      }),
    },
    userRole: {
      create: vi.fn(async ({ data }: { data: UserRoleRow }) => {
        state.userRoles.push(data);
        return data;
      }),
    },
    tenantDomain: {
      create: vi.fn(async ({ data }: { data: Omit<TenantDomainRow, 'id'> }) => {
        const row: TenantDomainRow = { id: id('domain'), ...data };
        state.tenantDomains.push(row);
        return row;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { hostname: string };
          update: Record<string, unknown>;
          create: Omit<TenantDomainRow, 'id'>;
        }) => {
          const existing = state.tenantDomains.find((d) => d.hostname === where.hostname);
          if (existing) return existing;
          const row: TenantDomainRow = { id: id('domain'), ...create };
          state.tenantDomains.push(row);
          return row;
        },
      ),
    },
    auditLog: {
      findFirst: vi.fn(async ({ where }: { where: { tenantId: string } }) => {
        const matching = state.auditLogs
          .filter((a) => a.tenantId === where.tenantId)
          .sort((a, b) => b.id - a.id);
        return matching[0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<AuditLogRow, 'id'> }) => {
        const row: AuditLogRow = { id: state.auditLogs.length + 1, ...data };
        state.auditLogs.push(row);
        return row;
      }),
    },
    // Activación de módulos en el tenant inicial (setup.service.ts:182-198).
    // Sin módulos en el registry, findMany devuelve [] → createMany no se llama.
    module: {
      findMany: vi.fn(
        async () =>
          [] as Array<{ id: string; name: string; manifest: unknown; enabledByDefault: boolean }>,
      ),
    },
    tenantModule: {
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: async (cb: (tx: typeof client) => Promise<unknown>) => cb(client),
  };

  return { state, client };
}

const dummyAuditLog = {
  record: vi.fn(async () => undefined),
} as unknown as ConstructorParameters<typeof SetupService>[3];

const realPasswords = new PasswordService();
const tokensFake = {
  sign: vi.fn(async () => ({
    accessToken: 'access.jwt.signed',
    refreshToken: 'refresh.jwt.signed',
    expiresIn: 3600,
  })),
} as unknown as ConstructorParameters<typeof SetupService>[2];

// Stub que siempre deja pasar — el comportamiento real de SetupTokenService
// (403 si falta/no coincide) se cubre en setup-token.service.test.ts y en el
// describe dedicado más abajo, que sí inyecta un stub que rechaza.
function permissiveSetupTokensStub() {
  return {
    assertValid: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
  } as unknown as ConstructorParameters<typeof SetupService>[5];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SetupService.getStatus', () => {
  it('devuelve initialized=false en DB virgen', async () => {
    const { client } = makeFakePrisma();
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );
    expect(await svc.getStatus()).toEqual({ initialized: false });
  });

  it('devuelve initialized=true cuando hay al menos un tenant activo', async () => {
    const { client, state } = makeFakePrisma();
    state.tenants.push({
      id: 't1',
      slug: 'acme',
      name: 'ACME',
      status: 'ACTIVE',
      deletedAt: null,
    });
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );
    expect(await svc.getStatus()).toEqual({ initialized: true });
  });

  it('ignora tenants soft-deleted', async () => {
    const { client, state } = makeFakePrisma();
    state.tenants.push({
      id: 't1',
      slug: 'archived',
      name: 'A',
      status: 'ARCHIVED',
      deletedAt: new Date(),
    });
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );
    expect(await svc.getStatus()).toEqual({ initialized: false });
  });
});

describe('SetupService.init', () => {
  const validDto = {
    organization: { name: 'ACME Corp', primaryHostname: 'lms.acme.test' },
    admin: { name: 'Pat Admin', email: 'pat@acme.test', password: 'super-secure-1234' },
  };

  it('bootstrappea tenant + roles + super_admin + dominio en DB virgen', async () => {
    const { client, state } = makeFakePrisma();
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );

    const result = await svc.init(validDto, 'lms.acme.test', { ip: null, userAgent: null });

    expect(state.tenants).toHaveLength(1);
    expect(state.tenants[0]).toMatchObject({
      slug: 'acme-corp',
      name: 'ACME Corp',
      status: 'ACTIVE',
    });
    expect(state.roles.map((r) => r.name).sort()).toEqual([
      'alumno',
      'auditor',
      'empresa_manager',
      'formador',
      'super_admin',
      'tenant_admin',
    ]);
    expect(state.users).toHaveLength(1);
    expect(state.users[0]).toMatchObject({
      email: 'pat@acme.test',
      name: 'Pat Admin',
      status: 'ACTIVE',
    });
    expect(state.users[0]?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(state.userRoles).toHaveLength(1);
    const superAdminRole = state.roles.find((r) => r.name === 'super_admin');
    expect(state.userRoles[0]?.roleId).toBe(superAdminRole?.id);
    expect(state.tenantDomains.find((d) => d.hostname === 'lms.acme.test')).toMatchObject({
      isPrimary: true,
      isVerified: true,
    });
    // Hostname distinto a localhost → además se siembra localhost para acceso local.
    expect(state.tenantDomains.find((d) => d.hostname === 'localhost')).toMatchObject({
      isPrimary: false,
      isVerified: true,
    });
    expect(result.tokens.accessToken).toBe('access.jwt.signed');
    expect(result.user).toMatchObject({
      email: 'pat@acme.test',
      tenantSlug: 'acme-corp',
      roles: ['super_admin'],
      mfaEnabled: false,
    });
  });

  it('rechaza con 409 ALREADY_INITIALIZED si ya hay un tenant', async () => {
    const { client, state } = makeFakePrisma();
    state.tenants.push({
      id: 't0',
      slug: 'existing',
      name: 'Existing',
      status: 'ACTIVE',
      deletedAt: null,
    });
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );

    await expect(svc.init(validDto, 'host.test', { ip: null, userAgent: null })).rejects.toThrow(
      ConflictException,
    );
    // No crea nada nuevo (más allá del tenant pre-existente).
    expect(state.tenants).toHaveLength(1);
    expect(state.users).toHaveLength(0);
    expect(state.roles).toHaveLength(0);
  });

  it('idempotencia bajo carrera: dos init concurrentes → uno gana, otro 409', async () => {
    const { client } = makeFakePrisma();
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );

    const [a, b] = await Promise.allSettled([
      svc.init(validDto, 'host.test', { ip: null, userAgent: null }),
      svc.init(
        { ...validDto, admin: { ...validDto.admin, email: 'other@acme.test' } },
        'host.test',
        { ip: null, userAgent: null },
      ),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
  });

  it('autogenera slug a partir del nombre con acentos y espacios', async () => {
    const { client, state } = makeFakePrisma();
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );

    await svc.init(
      {
        organization: { name: 'Centro de Formación Ñandú' },
        admin: { name: 'A', email: 'a@x.test', password: 'long-password-12' },
      },
      'localhost',
      { ip: null, userAgent: null },
    );
    expect(state.tenants[0]?.slug).toMatch(/^centro-de-formacion-/);
  });

  it('respeta slug explícito si lo pasa el usuario', async () => {
    const { client, state } = makeFakePrisma();
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );

    await svc.init(
      {
        organization: { name: 'Mi Empresa', slug: 'mi-org' },
        admin: { name: 'A', email: 'a@x.test', password: 'long-password-12' },
      },
      'localhost',
      { ip: null, userAgent: null },
    );
    expect(state.tenants[0]?.slug).toBe('mi-org');
  });

  it('cae al hostname del request si el cliente no provee primaryHostname', async () => {
    const { client, state } = makeFakePrisma();
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );

    await svc.init(
      {
        organization: { name: 'X' },
        admin: { name: 'A', email: 'a@x.test', password: 'long-password-12' },
      },
      'derived.from.host',
      { ip: null, userAgent: null },
    );
    expect(state.tenantDomains.find((d) => d.isPrimary)?.hostname).toBe('derived.from.host');
  });

  it('si hostname=localhost no duplica el upsert extra', async () => {
    const { client, state } = makeFakePrisma();
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      permissiveSetupTokensStub(),
    );

    await svc.init(
      {
        organization: { name: 'X', primaryHostname: 'localhost' },
        admin: { name: 'A', email: 'a@x.test', password: 'long-password-12' },
      },
      'localhost',
      { ip: null, userAgent: null },
    );
    const localhostDomains = state.tenantDomains.filter((d) => d.hostname === 'localhost');
    expect(localhostDomains).toHaveLength(1);
    expect(localhostDomains[0]?.isPrimary).toBe(true);
  });
});

describe('SetupService.init — gate del token de setup', () => {
  const validDto = {
    organization: { name: 'ACME Corp', primaryHostname: 'lms.acme.test' },
    admin: { name: 'Pat Admin', email: 'pat@acme.test', password: 'super-secure-1234' },
  };

  function rejectingSetupTokensStub() {
    return {
      assertValid: vi.fn(async () => {
        throw new ForbiddenException({ code: 'SETUP_TOKEN_INVALID', message: 'nope' });
      }),
      invalidate: vi.fn(async () => undefined),
    } as unknown as ConstructorParameters<typeof SetupService>[5];
  }

  it('rechaza con 403 en DB virgen si el token no es válido, sin crear nada', async () => {
    const { client, state } = makeFakePrisma();
    const setupTokens = rejectingSetupTokensStub();
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      setupTokens,
    );

    await expect(
      svc.init(validDto, 'host.test', { ip: null, userAgent: null }, 'token-que-sea'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(setupTokens.assertValid).toHaveBeenCalledWith('token-que-sea');
    expect(state.tenants).toHaveLength(0);
  });

  it('con token válido, invalida el token tras crear el tenant (uso único)', async () => {
    const { client } = makeFakePrisma();
    const setupTokens = permissiveSetupTokensStub() as unknown as {
      assertValid: ReturnType<typeof vi.fn>;
      invalidate: ReturnType<typeof vi.fn>;
    };
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      setupTokens as unknown as ConstructorParameters<typeof SetupService>[5],
    );

    await svc.init(validDto, 'host.test', { ip: null, userAgent: null }, 'token-valido');
    expect(setupTokens.assertValid).toHaveBeenCalledWith('token-valido');
    expect(setupTokens.invalidate).toHaveBeenCalledTimes(1);
  });

  it('si ya hay un tenant, NO consulta el token (prioriza el 409 de siempre)', async () => {
    const { client, state } = makeFakePrisma();
    state.tenants.push({
      id: 't0',
      slug: 'existing',
      name: 'Existing',
      status: 'ACTIVE',
      deletedAt: null,
    });
    const setupTokens = rejectingSetupTokensStub() as unknown as {
      assertValid: ReturnType<typeof vi.fn>;
      invalidate: ReturnType<typeof vi.fn>;
    };
    const svc = new SetupService(
      client as never,
      realPasswords,
      tokensFake,
      dummyAuditLog,
      sessionRegistryStub(tokensFake as never),
      setupTokens as unknown as ConstructorParameters<typeof SetupService>[5],
    );

    await expect(
      svc.init(validDto, 'host.test', { ip: null, userAgent: null }, null),
    ).rejects.toThrow(ConflictException);
    expect(setupTokens.assertValid).not.toHaveBeenCalled();
  });
});
