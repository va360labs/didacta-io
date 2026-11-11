import { describe, expect, it } from 'vitest';
import { AmbiguousTenantError, AuthService } from '../src/auth/auth.service';
import { forgotPasswordSchema, signinSchema } from '../src/auth/dto';
import { storedEmailFor, type EmailLookupPrisma } from '../src/auth/email-lookup';
import { sessionRegistryStub } from './helpers/session-registry-stub';

/**
 * El email del login NO distingue mayúsculas.
 *
 * Antes el login buscaba el texto exacto contra `(tenant_id, email)`: quien
 * escribía «Ana.Ruiz@example.com» con la cuenta guardada en minúsculas (el
 * móvil pone la primera en mayúscula) recibía «Credenciales inválidas» con la
 * contraseña buena.
 *
 * Lo que se fija aquí, además del caso feliz, es lo que NO debe cambiar: con
 * dos cuentas que solo difieren en mayúsculas no se elige ni se fusiona nada.
 */

// ---------------------------------------------------------------------------
// storedEmailFor
// ---------------------------------------------------------------------------

function lookupPrisma(rows: Array<{ tenantId: string; email: string }>): EmailLookupPrisma {
  return {
    user: {
      async findUnique({ where }) {
        const r = rows.find(
          (u) =>
            u.tenantId === where.tenantId_email.tenantId && u.email === where.tenantId_email.email,
        );
        return r ? { id: r.email } : null;
      },
      async findMany({ where, take }) {
        const buscado = where.email.equals.toLowerCase();
        return rows
          .filter((u) => u.tenantId === where.tenantId && u.email.toLowerCase() === buscado)
          .slice(0, take)
          .map((u) => ({ email: u.email }));
      },
    },
  };
}

describe('storedEmailFor', () => {
  const T = 'tenant-1';

  it('escrito con mayúscula, guardado en minúsculas', async () => {
    const prisma = lookupPrisma([{ tenantId: T, email: 'ana.ruiz@example.com' }]);
    expect(await storedEmailFor(prisma, T, 'Ana.Ruiz@example.com')).toBe('ana.ruiz@example.com');
  });

  it('guardado con mayúsculas y escrito en minúsculas también entra', async () => {
    const prisma = lookupPrisma([{ tenantId: T, email: 'Ana.Ruiz@Example.com' }]);
    expect(await storedEmailFor(prisma, T, 'ana.ruiz@example.com')).toBe('Ana.Ruiz@Example.com');
  });

  it('la coincidencia exacta gana aunque haya otra fila con otras mayúsculas', async () => {
    const prisma = lookupPrisma([
      { tenantId: T, email: 'pablo@example.com' },
      { tenantId: T, email: 'Pablo@example.com' },
    ]);
    expect(await storedEmailFor(prisma, T, 'Pablo@example.com')).toBe('Pablo@example.com');
    expect(await storedEmailFor(prisma, T, 'pablo@example.com')).toBe('pablo@example.com');
  });

  it('dos filas que solo difieren en mayúsculas y ninguna exacta: no elige (devuelve lo escrito)', async () => {
    const prisma = lookupPrisma([
      { tenantId: T, email: 'pablo@example.com' },
      { tenantId: T, email: 'Pablo@example.com' },
    ]);
    expect(await storedEmailFor(prisma, T, 'PABLO@example.com')).toBe('PABLO@example.com');
  });

  it('no cruza tenants', async () => {
    const prisma = lookupPrisma([{ tenantId: 'otro', email: 'ana.ruiz@example.com' }]);
    expect(await storedEmailFor(prisma, T, 'Ana.Ruiz@example.com')).toBe('Ana.Ruiz@example.com');
  });
});

// ---------------------------------------------------------------------------
// AuthService.signin
// ---------------------------------------------------------------------------

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
}
interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
}

function buildService(seed: { tenants?: TenantRow[]; users: UserRow[] }) {
  const tenants: TenantRow[] = seed.tenants ?? [
    { id: 't1', slug: 'demo', name: 'Demo', status: 'ACTIVE' },
  ];
  const users = seed.users;
  const withRelations = (u: UserRow) => ({
    ...u,
    name: null,
    avatarUrl: null,
    mfaEnabled: false,
    mustChangePassword: false,
    onboardingCompletedAt: null,
    deletedAt: null,
    roles: [{ role: { name: 'alumno' } }],
    tenant: tenants.find((t) => t.id === u.tenantId)!,
  });
  const prisma = {
    tenant: {
      async findUnique(args: { where: { id?: string; slug?: string } }) {
        return (
          tenants.find((t) =>
            args.where.id ? t.id === args.where.id : t.slug === args.where.slug,
          ) ?? null
        );
      },
    },
    user: {
      async findUnique(args: { where: { tenantId_email: { tenantId: string; email: string } } }) {
        const w = args.where.tenantId_email;
        const u = users.find((x) => x.tenantId === w.tenantId && x.email === w.email);
        return u ? withRelations(u) : null;
      },
      async findMany(args: {
        where: {
          tenantId?: string;
          email: string | { equals: string; mode?: 'insensitive' };
          status?: string;
          tenant?: { status: string };
        };
        take: number;
      }) {
        // Fiel a Prisma: un `email` en texto plano es una comparación EXACTA.
        // Así el control (código sin arreglar) falla por lo que tiene que fallar.
        const e = args.where.email;
        const matchEmail = (stored: string) =>
          typeof e === 'string'
            ? stored === e
            : e.mode === 'insensitive'
              ? stored.toLowerCase() === e.equals.toLowerCase()
              : stored === e.equals;
        return users
          .filter((u) => !args.where.tenantId || u.tenantId === args.where.tenantId)
          .filter((u) => matchEmail(u.email))
          .filter((u) => !args.where.status || u.status === args.where.status)
          .map(withRelations)
          .filter((u) => !args.where.tenant || u.tenant.status === args.where.tenant.status)
          .slice(0, args.take);
      },
      async update() {
        return {};
      },
    },
  };
  const audit: Array<{ action: string }> = [];
  const service = new AuthService(
    prisma as never,
    { verify: async (hash: string, plain: string) => hash === `hash:${plain}` } as never,
    { sign: async () => ({ accessToken: 'a', refreshToken: 'r' }) } as never,
    { record: async (e: { action: string }) => void audit.push(e) } as never,
    { evaluateLoginPolicy: async () => ({ outcome: 'allow' }) } as never,
    sessionRegistryStub({
      sign: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
    }),
    { get: async () => undefined } as never,
  );
  return { service, audit };
}

const ANA: UserRow = {
  id: 'u-ana',
  tenantId: 't1',
  email: 'ana.ruiz@example.com',
  passwordHash: 'hash:secreta-de-ana',
  status: 'ACTIVE',
};

describe('AuthService.signin · el email no distingue mayúsculas', () => {
  it('control: con el email exacto entra (el camino de siempre)', async () => {
    const { service } = buildService({ users: [ANA] });
    const res = await service.signin({
      tenantSlug: 'demo',
      email: 'ana.ruiz@example.com',
      password: 'secreta-de-ana',
    });
    expect(res.user.id).toBe('u-ana');
  });

  it.each(['Ana.Ruiz@example.com', 'ANA.RUIZ@EXAMPLE.COM', 'ana.ruiz@Example.Com'])(
    'escrito «%s» con la cuenta guardada en minúsculas → entra en SU cuenta',
    async (typed) => {
      const { service } = buildService({ users: [ANA] });
      const res = await service.signin({
        tenantSlug: 'demo',
        email: typed,
        password: 'secreta-de-ana',
      });
      expect(res.user.id).toBe('u-ana');
      // La sesión lleva el email de la cuenta, no lo tecleado.
      expect(res.user.email).toBe('ana.ruiz@example.com');
    },
  );

  it('cuenta guardada CON mayúsculas y email escrito en minúsculas → entra', async () => {
    const { service } = buildService({
      users: [{ ...ANA, email: 'Ana.Ruiz@Example.com' }],
    });
    const res = await service.signin({
      tenantSlug: 'demo',
      email: 'ana.ruiz@example.com',
      password: 'secreta-de-ana',
    });
    expect(res.user.id).toBe('u-ana');
  });

  it('las mayúsculas no relajan la contraseña: una mala sigue siendo 401', async () => {
    const { service, audit } = buildService({ users: [ANA] });
    await expect(
      service.signin({ tenantSlug: 'demo', email: 'Ana.Ruiz@example.com', password: 'otra' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(audit.map((a) => a.action)).toEqual(['user.signin.failed']);
  });

  it('no cruza tenants: el mismo email en otro tenant no abre este', async () => {
    const { service } = buildService({
      tenants: [
        { id: 't1', slug: 'demo', name: 'Demo', status: 'ACTIVE' },
        { id: 't2', slug: 'otra', name: 'Otra', status: 'ACTIVE' },
      ],
      users: [{ ...ANA, tenantId: 't2' }],
    });
    await expect(
      service.signin({
        tenantSlug: 'demo',
        email: 'Ana.Ruiz@example.com',
        password: 'secreta-de-ana',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  describe('dos cuentas que ya existen y solo difieren en mayúsculas', () => {
    const MINUS: UserRow = { ...ANA, id: 'u-minus', passwordHash: 'hash:pass-minus' };
    const MAYUS: UserRow = {
      ...ANA,
      id: 'u-mayus',
      email: 'Ana.Ruiz@example.com',
      passwordHash: 'hash:pass-mayus',
    };

    it('cada una sigue entrando en la SUYA con su email exacto', async () => {
      const { service } = buildService({ users: [MINUS, MAYUS] });
      const a = await service.signin({
        tenantSlug: 'demo',
        email: 'ana.ruiz@example.com',
        password: 'pass-minus',
      });
      const b = await service.signin({
        tenantSlug: 'demo',
        email: 'Ana.Ruiz@example.com',
        password: 'pass-mayus',
      });
      expect(a.user.id).toBe('u-minus');
      expect(b.user.id).toBe('u-mayus');
    });

    it('la contraseña de una no abre la otra', async () => {
      const { service } = buildService({ users: [MINUS, MAYUS] });
      await expect(
        service.signin({
          tenantSlug: 'demo',
          email: 'Ana.Ruiz@example.com',
          password: 'pass-minus',
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('una tercera forma no elige ninguna: 401 con cualquiera de las dos contraseñas', async () => {
      const { service } = buildService({ users: [MINUS, MAYUS] });
      for (const password of ['pass-minus', 'pass-mayus']) {
        await expect(
          service.signin({ tenantSlug: 'demo', email: 'ANA.RUIZ@EXAMPLE.COM', password }),
        ).rejects.toMatchObject({ status: 401 });
      }
    });
  });

  describe('sin host ni slug: el tenant se resuelve por email', () => {
    it('sin distinguir mayúsculas', async () => {
      const { service } = buildService({ users: [ANA] });
      const res = await service.signin({
        email: 'Ana.Ruiz@example.com',
        password: 'secreta-de-ana',
      });
      expect(res.user.id).toBe('u-ana');
      expect(res.user.tenantSlug).toBe('demo');
    });

    it('dos cuentas del MISMO tenant que difieren en mayúsculas no son «varias organizaciones»', async () => {
      const { service } = buildService({
        users: [ANA, { ...ANA, id: 'u-mayus', email: 'Ana.Ruiz@example.com' }],
      });
      const res = await service.signin({
        email: 'ana.ruiz@example.com',
        password: 'secreta-de-ana',
      });
      expect(res.user.id).toBe('u-ana');
    });

    it('el mismo email en DOS tenants sigue siendo ambiguo, se escriba como se escriba', async () => {
      const { service } = buildService({
        tenants: [
          { id: 't1', slug: 'demo', name: 'Demo', status: 'ACTIVE' },
          { id: 't2', slug: 'otra', name: 'Otra', status: 'ACTIVE' },
        ],
        users: [ANA, { ...ANA, id: 'u-otra', tenantId: 't2', email: 'Ana.Ruiz@example.com' }],
      });
      await expect(
        service.signin({ email: 'ANA.RUIZ@example.com', password: 'secreta-de-ana' }),
      ).rejects.toBeInstanceOf(AmbiguousTenantError);
    });
  });
});

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

describe('DTOs de acceso · espacios alrededor del email', () => {
  // El autocompletado del móvil deja un espacio detrás; sin recortar, zod lo
  // rechazaba como «email inválido» y el usuario no veía por qué.
  it('signin recorta el email', () => {
    expect(signinSchema.parse({ email: ' ana.ruiz@example.com ', password: 'x' }).email).toBe(
      'ana.ruiz@example.com',
    );
  });

  it('forgot-password recorta el email', () => {
    expect(forgotPasswordSchema.parse({ email: 'ana.ruiz@example.com ' }).email).toBe(
      'ana.ruiz@example.com',
    );
  });

  it('recortar no convierte en válido lo que no es un email', () => {
    expect(() => signinSchema.parse({ email: '  no-es-un-email  ', password: 'x' })).toThrow();
  });
});
