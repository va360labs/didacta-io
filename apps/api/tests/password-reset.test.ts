import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { PasswordResetService } from '../src/auth/password-reset.service';

interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  passwordHash: string;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
}

interface TokenRow {
  id: string;
  userId: string;
  tenantId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  requestIp: string | null;
  requestUa: string | null;
  createdAt: Date;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
}

function hash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeFakePrisma() {
  const tenants: TenantRow[] = [
    { id: 'tenant-1', slug: 'va360', name: 'VA360 Academy', status: 'ACTIVE' },
    { id: 'tenant-2', slug: 'suspendida', name: 'Suspendida', status: 'SUSPENDED' },
  ];
  const users: UserRow[] = [
    {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'valen@va360.com',
      name: 'Valentín',
      passwordHash: 'old-hash',
      status: 'ACTIVE',
    },
    {
      id: 'user-2',
      tenantId: 'tenant-1',
      email: 'suspendido@va360.com',
      name: null,
      passwordHash: 'old-hash',
      status: 'SUSPENDED',
    },
  ];
  const tokens: TokenRow[] = [];
  let tokenAutoId = 1;

  return {
    tokens,
    users,
    tenants,
    tenant: {
      async findUnique(args: { where: { slug: string } }) {
        return tenants.find((t) => t.slug === args.where.slug) ?? null;
      },
    },
    user: {
      async findUnique(args: { where: { tenantId_email?: { tenantId: string; email: string } } }) {
        const w = args.where.tenantId_email;
        if (!w) return null;
        return users.find((u) => u.tenantId === w.tenantId && u.email === w.email) ?? null;
      },
      async update(args: { where: { id: string }; data: { passwordHash?: string } }) {
        const u = users.find((x) => x.id === args.where.id);
        if (!u) throw new Error('user not found');
        if (args.data.passwordHash !== undefined) u.passwordHash = args.data.passwordHash;
        return u;
      },
    },
    passwordResetToken: {
      async create(args: {
        data: {
          userId: string;
          tenantId: string;
          tokenHash: string;
          expiresAt: Date;
          requestIp: string | null;
          requestUa: string | null;
        };
      }) {
        const row: TokenRow = {
          id: `tok-${tokenAutoId++}`,
          ...args.data,
          usedAt: null,
          createdAt: new Date(),
        };
        tokens.push(row);
        return row;
      },
      async findUnique(args: { where: { tokenHash: string } }) {
        return tokens.find((t) => t.tokenHash === args.where.tokenHash) ?? null;
      },
      async update(args: { where: { id: string }; data: { usedAt?: Date } }) {
        const t = tokens.find((x) => x.id === args.where.id);
        if (!t) throw new Error('token not found');
        if (args.data.usedAt !== undefined) t.usedAt = args.data.usedAt;
        return t;
      },
      async updateMany(args: {
        where: { userId: string; usedAt: null; expiresAt: { gt: Date } };
        data: { usedAt: Date };
      }) {
        let count = 0;
        for (const t of tokens) {
          if (
            t.userId === args.where.userId &&
            t.usedAt === null &&
            t.expiresAt.getTime() > args.where.expiresAt.gt.getTime()
          ) {
            t.usedAt = args.data.usedAt;
            count++;
          }
        }
        return { count };
      },
    },
    async $transaction(operations: Array<Promise<unknown>>) {
      return Promise.all(operations);
    },
  };
}

const fakePasswords = {
  async hash(s: string) {
    return `argon2:${s}`;
  },
  async verify(_h: string, _p: string) {
    return true;
  },
};

const fakeAuditLog = {
  async record(_input: unknown) {
    /* noop */
  },
};

const fakeSmtp = {
  parseConfig() {
    throw new Error('no usado en estos tests');
  },
  async send() {
    return { ok: true, messageId: 'fake' };
  },
  async verify() {
    return { ok: true };
  },
  isConfigValid() {
    return true;
  },
};

const fakeTenantConfig = {
  async get() {
    return undefined;
  },
  async set() {
    /* noop */
  },
};

const fakeLogger = { warn: () => {}, log: () => {}, error: () => {}, debug: () => {} };

function makeService() {
  const prisma = makeFakePrisma();
  const service = new PasswordResetService(
    prisma as never,
    fakePasswords as never,
    fakeAuditLog as never,
    fakeSmtp as never,
    fakeTenantConfig as never,
    fakeLogger as never,
  );
  return { service, prisma };
}

describe('PasswordResetService.request', () => {
  it('genera un token cuando el user existe y está activo', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'va360', email: 'valen@va360.com' });
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
    expect(result?.userName).toBe('Valentín');
    expect(result?.rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.tokens).toHaveLength(1);
    // El token persistido es el hash, no el raw.
    expect(prisma.tokens[0].tokenHash).toBe(hash(result!.rawToken));
  });

  it('devuelve null sin crear token si el user no existe (anti user enumeration)', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'va360', email: 'inexistente@va360.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('devuelve null si el user está suspendido', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'va360', email: 'suspendido@va360.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('devuelve null si el tenant está suspendido', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'suspendida', email: 'valen@va360.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('invalida tokens previos no usados al pedir uno nuevo', async () => {
    const { service, prisma } = makeService();
    const a = await service.request({ tenantSlug: 'va360', email: 'valen@va360.com' });
    const b = await service.request({ tenantSlug: 'va360', email: 'valen@va360.com' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Ambos rows existen, el primero tiene usedAt seteado por la invalidación.
    expect(prisma.tokens).toHaveLength(2);
    expect(prisma.tokens[0].usedAt).not.toBeNull();
    expect(prisma.tokens[1].usedAt).toBeNull();
  });

  it('expira en 60 minutos por default', async () => {
    const { service, prisma } = makeService();
    const before = Date.now();
    await service.request({ tenantSlug: 'va360', email: 'valen@va360.com' });
    const expiresAt = prisma.tokens[0].expiresAt.getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(59 * 60_000);
    expect(expiresAt - before).toBeLessThanOrEqual(61 * 60_000);
  });

  // ── CORE-FIX-03: allowPending para flujos admin-triggered ──

  it('PENDING + allowPending=true → genera token (admin invite/resend)', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({
      id: 'user-pending',
      tenantId: 'tenant-1',
      email: 'pending@va360.com',
      name: 'Alumno Migrado',
      passwordHash: '',
      status: 'PENDING',
    });
    const result = await service.request(
      { tenantSlug: 'va360', email: 'pending@va360.com' },
      undefined,
      { allowPending: true },
    );
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-pending');
    expect(prisma.tokens).toHaveLength(1);
  });

  it('PENDING + allowPending omitido → null (anti-enum del path público se mantiene)', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({
      id: 'user-pending-2',
      tenantId: 'tenant-1',
      email: 'pending2@va360.com',
      name: null,
      passwordHash: '',
      status: 'PENDING',
    });
    const result = await service.request({ tenantSlug: 'va360', email: 'pending2@va360.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('SUSPENDED + allowPending=true → null (allowPending NO desbloquea SUSPENDED)', async () => {
    const { service, prisma } = makeService();
    const result = await service.request(
      { tenantSlug: 'va360', email: 'suspendido@va360.com' },
      undefined,
      { allowPending: true },
    );
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('ACTIVE + allowPending=true → sigue generando token (regresión)', async () => {
    const { service, prisma } = makeService();
    const result = await service.request(
      { tenantSlug: 'va360', email: 'valen@va360.com' },
      undefined,
      { allowPending: true },
    );
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
    expect(prisma.tokens).toHaveLength(1);
  });

  it('user inexistente + allowPending=true → null (anti-enum)', async () => {
    const { service, prisma } = makeService();
    const result = await service.request(
      { tenantSlug: 'va360', email: 'nadie@va360.com' },
      undefined,
      { allowPending: true },
    );
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });
});

describe('PasswordResetService.reset', () => {
  it('cambia la password y marca el token como usado', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'va360', email: 'valen@va360.com' });
    expect(result).not.toBeNull();
    await service.reset(result!.rawToken, 'NuevaPasswordSegura123');
    expect(prisma.users[0].passwordHash).toBe('argon2:NuevaPasswordSegura123');
    expect(prisma.tokens[0].usedAt).not.toBeNull();
  });

  it('rechaza si el token no existe', async () => {
    const { service } = makeService();
    await expect(service.reset('a'.repeat(64), 'OtraPasswordSegura123')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza un token ya usado (single-use)', async () => {
    const { service } = makeService();
    const result = await service.request({ tenantSlug: 'va360', email: 'valen@va360.com' });
    await service.reset(result!.rawToken, 'NuevaPasswordSegura123');
    await expect(service.reset(result!.rawToken, 'OtraPasswordSegura123')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza un token expirado', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'va360', email: 'valen@va360.com' });
    // Forzamos expiración manualmente.
    prisma.tokens[0].expiresAt = new Date(Date.now() - 1000);
    await expect(service.reset(result!.rawToken, 'NuevaPasswordSegura123')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('PasswordResetService.buildResetEmail', () => {
  it('construye un email con greeting nominal cuando hay name (default Didacta sin tenantName)', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('abc123', 'Valentín', 'https://didacta.local');
    expect(out.subject).toBe('Restablecer tu contraseña en Didacta');
    expect(out.text).toContain('Hola Valentín');
    expect(out.html).toContain('Hola Valentín');
    expect(out.text).toContain('https://didacta.local/reset-password?token=abc123');
    // Default sin tenantName → la firma genérica + footer.
    expect(out.text).toContain('— Equipo Didacta');
    expect(out.text).toContain('Powered by Didacta.io');
    expect(out.html).toContain('Powered by Didacta.io');
  });

  it('cae a un greeting genérico cuando no hay name', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('xyz', null, 'https://x.test');
    expect(out.text).toContain('Hola,');
    expect(out.html).toContain('Hola,');
  });

  it('encodeURIComponent del token raro', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('a/b+c=', null, 'https://x.test');
    expect(out.text).toContain('token=a%2Fb%2Bc%3D');
  });

  // alpha.77 — branding por tenant
  it('firma como "Equipo {tenantName}" + footer Powered by Didacta.io cuando se pasa tenantName', () => {
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      'Valentín',
      'https://dev.didacta.io',
      'VA360 Academy',
    );
    expect(out.subject).toBe('Restablecer tu contraseña en VA360 Academy');
    expect(out.text).toContain('— Equipo VA360 Academy');
    expect(out.html).toContain('— Equipo VA360 Academy');
    expect(out.text).toContain('cuenta en VA360 Academy');
    // Footer discreto con marca plataforma.
    expect(out.text).toContain('Powered by Didacta.io');
    expect(out.html).toContain('Powered by Didacta.io');
    expect(out.html).toContain('color: #999');
  });

  it('request() expone tenantName desde el tenant resuelto', async () => {
    const { service } = makeService();
    const result = await service.request({ tenantSlug: 'va360', email: 'valen@va360.com' });
    expect(result?.tenantName).toBe('VA360 Academy');
  });

  // alpha.82 — logo por tenant en el header del email
  it('embebe el logo del tenant en el header HTML cuando se pasa logoUrl absoluto', () => {
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      'Valentín',
      'https://dev.didacta.io',
      'VA360 Academy',
      'https://cdn.didacta.io/logo.png',
    );
    expect(out.html).toContain('<img src="https://cdn.didacta.io/logo.png"');
    expect(out.html).toContain('alt="VA360 Academy"');
    // El texto plano no se ve afectado por el logo.
    expect(out.text).not.toContain('<img');
  });

  it('NO renderiza img cuando logoUrl es null (fallback sin romper)', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('abc', 'Valentín', 'https://x.test', 'VA360 Academy', null);
    expect(out.html).not.toContain('<img');
    expect(out.html).toContain('— Equipo VA360 Academy');
  });

  it('NO renderiza img cuando logoUrl no es http(s) (defensa anti-inyección)', () => {
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      null,
      'https://x.test',
      'VA360 Academy',
      'javascript:alert(1)',
    );
    expect(out.html).not.toContain('<img');
    expect(out.html).not.toContain('javascript:');
  });

  it('escapa el tenantName en el alt del logo (XSS en atributo)', () => {
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      null,
      'https://x.test',
      'Acme "Corp" <b>',
      'https://cdn.test/l.png',
    );
    expect(out.html).toContain('alt="Acme &quot;Corp&quot; &lt;b&gt;"');
  });
});
