import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { PasswordResetService } from '../src/auth/password-reset.service';

interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  /** null = invitado que aún no ha definido contraseña (columna nullable). */
  passwordHash: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  /**
   * Idioma del destinatario. Se deja OPCIONAL en la fila falsa a propósito:
   * las filas que no lo declaran ejercitan el camino degradado (columna vacía
   * o dato legacy) y comprueban que sigue saliendo el español.
   */
  locale?: string;
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
    { id: 'tenant-1', slug: 'demo', name: 'Academia Demo', status: 'ACTIVE' },
    { id: 'tenant-2', slug: 'suspendida', name: 'Suspendida', status: 'SUSPENDED' },
  ];
  const users: UserRow[] = [
    {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'ana@example.com',
      name: 'Ana',
      passwordHash: 'old-hash',
      status: 'ACTIVE',
    },
    {
      id: 'user-2',
      tenantId: 'tenant-1',
      email: 'suspendido@example.com',
      name: null,
      passwordHash: 'old-hash',
      status: 'SUSPENDED',
    },
    {
      id: 'user-en',
      tenantId: 'tenant-1',
      email: 'john@example.com',
      name: 'John',
      passwordHash: 'old-hash',
      status: 'ACTIVE',
      locale: 'en-US',
    },
    {
      id: 'user-pt',
      tenantId: 'tenant-1',
      email: 'joao@example.com',
      name: 'Joao',
      passwordHash: 'old-hash',
      status: 'ACTIVE',
      locale: 'pt-BR',
    },
    {
      id: 'user-fr',
      tenantId: 'tenant-1',
      email: 'jean@example.com',
      name: 'Jean',
      passwordHash: 'old-hash',
      status: 'ACTIVE',
      // Guardado por SCIM (copia el locale del IdP sin validar): sin catálogo.
      locale: 'fr-FR',
    },
    {
      id: 'user-blank-locale',
      tenantId: 'tenant-1',
      email: 'blank@example.com',
      name: 'Blanca',
      passwordHash: 'old-hash',
      status: 'ACTIVE',
      locale: '   ',
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
      async findUnique(args: {
        where: { id?: string; tenantId_email?: { tenantId: string; email: string } };
      }) {
        if (args.where.id) return users.find((u) => u.id === args.where.id) ?? null;
        const w = args.where.tenantId_email;
        if (!w) return null;
        return users.find((u) => u.tenantId === w.tenantId && u.email === w.email) ?? null;
      },
      /**
       * Atiende las dos consultas por email del servicio: la de
       * `storedEmailFor` (acotada a un tenant) y la que resuelve el tenant por
       * email cuando no hay host ni slug (cruza tenants y trae el suyo).
       *
       * Fiel a Prisma: un `email` en texto plano es una comparación EXACTA y
       * solo `mode: 'insensitive'` ignora mayúsculas. Sin esa fidelidad el
       * doble contestaría lo mismo con el código sin arreglar.
       */
      async findMany(args: {
        where: {
          tenantId?: string;
          email: string | { equals: string; mode?: 'insensitive' };
          status?: UserRow['status'];
          tenant?: { status: TenantRow['status'] };
        };
        take: number;
      }) {
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
          .map((u) => ({ ...u, tenant: tenants.find((t) => t.id === u.tenantId)! }))
          .filter((u) => !args.where.tenant || u.tenant.status === args.where.tenant.status)
          .slice(0, args.take);
      },
      async update(args: {
        where: { id: string };
        data: { passwordHash?: string; status?: UserRow['status'] };
      }) {
        const u = users.find((x) => x.id === args.where.id);
        if (!u) throw new Error('user not found');
        if (args.data.passwordHash !== undefined) u.passwordHash = args.data.passwordHash;
        if (args.data.status !== undefined) u.status = args.data.status;
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
    const result = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
    expect(result?.userName).toBe('Ana');
    expect(result?.rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.tokens).toHaveLength(1);
    // El token persistido es el hash, no el raw.
    expect(prisma.tokens[0]!.tokenHash).toBe(hash(result!.rawToken));
  });

  it('expone el idioma del DESTINATARIO para que el email salga en su lengua', async () => {
    const { service } = makeService();
    const en = await service.request({ tenantSlug: 'demo', email: 'john@example.com' });
    expect(en?.locale).toBe('en-US');
    const pt = await service.request({ tenantSlug: 'demo', email: 'joao@example.com' });
    expect(pt?.locale).toBe('pt-BR');
    // Un locale SIN catálogo se devuelve TAL CUAL (un override per-tenant en ese
    // locale podría ganar); quien lo aplana al español es el catálogo, no esta
    // capa.
    const fr = await service.request({ tenantSlug: 'demo', email: 'jean@example.com' });
    expect(fr?.locale).toBe('fr-FR');
  });

  it('CAMINO DEGRADADO: fila sin locale o con locale en blanco → es-ES explícito', async () => {
    const { service } = makeService();
    const legacy = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    expect(legacy?.locale).toBe('es-ES');
    const blank = await service.request({ tenantSlug: 'demo', email: 'blank@example.com' });
    expect(blank?.locale).toBe('es-ES');
  });

  it('el email no distingue mayúsculas: «Ana@Example.com» es la cuenta de «ana@example.com»', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'demo', email: 'Ana@Example.com' });
    expect(result?.userId).toBe('user-1');
    // Lo que se devuelve para enviar es la dirección GUARDADA, no la tecleada.
    expect(result?.email).toBe('ana@example.com');
    expect(prisma.tokens).toHaveLength(1);
  });

  it('cuenta guardada CON mayúsculas y email escrito en minúsculas: también la encuentra', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({ ...prisma.users[0]!, id: 'user-mayus', email: 'Marta.Gil@Example.com' });
    const result = await service.request({ tenantSlug: 'demo', email: 'marta.gil@example.com' });
    expect(result?.userId).toBe('user-mayus');
    expect(result?.email).toBe('Marta.Gil@Example.com');
  });

  it('dos cuentas que solo difieren en mayúsculas: la escrita EXACTA sigue siendo la suya', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({ ...prisma.users[0]!, id: 'user-dup', email: 'ANA@example.com' });
    expect((await service.request({ tenantSlug: 'demo', email: 'ANA@example.com' }))?.userId).toBe(
      'user-dup',
    );
    expect((await service.request({ tenantSlug: 'demo', email: 'ana@example.com' }))?.userId).toBe(
      'user-1',
    );
  });

  it('dos cuentas que solo difieren en mayúsculas y una tercera forma: no elige ninguna', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({ ...prisma.users[0]!, id: 'user-dup', email: 'ANA@example.com' });
    const result = await service.request({ tenantSlug: 'demo', email: 'Ana@Example.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('sin host ni slug, el tenant se resuelve por email sin distinguir mayúsculas', async () => {
    const { service } = makeService();
    const result = await service.request({ email: 'Ana@Example.com' });
    expect(result?.userId).toBe('user-1');
    expect(result?.tenantId).toBe('tenant-1');
  });

  it('sin host ni slug, dos cuentas del MISMO tenant que difieren en mayúsculas no lo hacen ambiguo', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({ ...prisma.users[0]!, id: 'user-dup', email: 'ANA@example.com' });
    // El tenant se resuelve (es uno solo); la cuenta exacta es la de siempre.
    const result = await service.request({ email: 'ana@example.com' });
    expect(result?.userId).toBe('user-1');
  });

  it('sin host ni slug, el mismo email en DOS tenants sigue sin resolverse (anti-enumeración)', async () => {
    const { service, prisma } = makeService();
    prisma.tenants.push({ id: 'tenant-3', slug: 'otra', name: 'Otra', status: 'ACTIVE' });
    prisma.users.push({
      ...prisma.users[0]!,
      id: 'user-otra',
      tenantId: 'tenant-3',
      email: 'Ana@example.com',
    });
    expect(await service.request({ email: 'ana@example.com' })).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('devuelve null sin crear token si el user no existe (anti user enumeration)', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'demo', email: 'inexistente@example.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('devuelve null si el user está suspendido', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'demo', email: 'suspendido@example.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('devuelve null si el tenant está suspendido', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'suspendida', email: 'ana@example.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('invalida tokens previos no usados al pedir uno nuevo', async () => {
    const { service, prisma } = makeService();
    const a = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    const b = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Ambos rows existen, el primero tiene usedAt seteado por la invalidación.
    expect(prisma.tokens).toHaveLength(2);
    expect(prisma.tokens[0]!.usedAt).not.toBeNull();
    expect(prisma.tokens[1]!.usedAt).toBeNull();
  });

  it('expira en 60 minutos por default', async () => {
    const { service, prisma } = makeService();
    const before = Date.now();
    await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    const expiresAt = prisma.tokens[0]!.expiresAt.getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(59 * 60_000);
    expect(expiresAt - before).toBeLessThanOrEqual(61 * 60_000);
  });

  // ── CORE-FIX-03: allowPending para flujos admin-triggered ──

  it('PENDING + allowPending=true → genera token (admin invite/resend)', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({
      id: 'user-pending',
      tenantId: 'tenant-1',
      email: 'pending@example.com',
      name: 'Alumno Migrado',
      passwordHash: null,
      status: 'PENDING',
    });
    const result = await service.request(
      { tenantSlug: 'demo', email: 'pending@example.com' },
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
      email: 'pending2@example.com',
      name: null,
      passwordHash: null,
      status: 'PENDING',
    });
    const result = await service.request({ tenantSlug: 'demo', email: 'pending2@example.com' });
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('SUSPENDED + allowPending=true → null (allowPending NO desbloquea SUSPENDED)', async () => {
    const { service, prisma } = makeService();
    const result = await service.request(
      { tenantSlug: 'demo', email: 'suspendido@example.com' },
      undefined,
      { allowPending: true },
    );
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });

  it('ACTIVE + allowPending=true → sigue generando token (regresión)', async () => {
    const { service, prisma } = makeService();
    const result = await service.request(
      { tenantSlug: 'demo', email: 'ana@example.com' },
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
      { tenantSlug: 'demo', email: 'nadie@example.com' },
      undefined,
      { allowPending: true },
    );
    expect(result).toBeNull();
    expect(prisma.tokens).toHaveLength(0);
  });
});

describe('PasswordResetService.requestAndSendEmail', () => {
  /**
   * La búsqueda ya no distingue mayúsculas, así que lo tecleado puede no ser
   * letra a letra la dirección de la cuenta. El enlace abre la cuenta: solo
   * puede salir hacia el buzón que consta en ella.
   */
  it('envía el enlace a la dirección GUARDADA, no a la que tecleó quien lo pide', async () => {
    const prisma = makeFakePrisma();
    const sent: Array<{ to: string }> = [];
    const smtp = {
      ...fakeSmtp,
      async send(_config: unknown, message: { to: string }) {
        sent.push(message);
        return { ok: true, messageId: 'fake' };
      },
    };
    const smtpResolver = { resolve: async () => ({ config: {}, source: 'tenant' }) };
    const service = new PasswordResetService(
      prisma as never,
      fakePasswords as never,
      fakeAuditLog as never,
      smtp as never,
      fakeTenantConfig as never,
      fakeLogger as never,
      smtpResolver as never,
    );

    await service.requestAndSendEmail(
      { tenantSlug: 'demo', email: 'ANA@EXAMPLE.COM' },
      'https://aula.example.com',
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ana@example.com');
  });

  /**
   * El flujo público no sabe en qué aula está la cuenta hasta que este servicio
   * la encuentra (puede venir por el slug del cuerpo o por el correo). La base
   * del enlace se pide ENTONCES, con el tenant de la cuenta: calcularla antes,
   * con el dominio de la petición, dejaba que un `Host` cualquiera decidiera
   * adónde apunta un enlace que lleva el token.
   */
  it('la base del enlace se pide con el tenant en el que se ENCONTRÓ la cuenta', async () => {
    const prisma = makeFakePrisma();
    const sent: Array<Record<string, unknown>> = [];
    const smtp = {
      ...fakeSmtp,
      async send(_config: unknown, message: Record<string, unknown>) {
        sent.push(message);
        return { ok: true, messageId: 'fake' };
      },
    };
    const smtpResolver = { resolve: async () => ({ config: {}, source: 'tenant' }) };
    const service = new PasswordResetService(
      prisma as never,
      fakePasswords as never,
      fakeAuditLog as never,
      smtp as never,
      fakeTenantConfig as never,
      fakeLogger as never,
      smtpResolver as never,
    );
    const baseFor = vi.fn(async (tenantId: string) => `https://${tenantId}.aula.example`);

    await service.requestAndSendEmail({ tenantSlug: 'demo', email: 'ana@example.com' }, baseFor);

    expect(baseFor).toHaveBeenCalledTimes(1);
    expect(baseFor).toHaveBeenCalledWith('tenant-1');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain(
      'https://tenant-1.aula.example/reset-password?token=',
    );
  });

  it('si la cuenta no existe, ni se pide la base ni se envía nada', async () => {
    const { service } = makeService();
    const baseFor = vi.fn(async () => 'https://x.example');
    await service.requestAndSendEmail({ tenantSlug: 'demo', email: 'nadie@example.com' }, baseFor);
    expect(baseFor).not.toHaveBeenCalled();
  });
});

describe('PasswordResetService.reset', () => {
  it('cambia la password y marca el token como usado', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    expect(result).not.toBeNull();
    await service.reset(result!.rawToken, 'NuevaPasswordSegura123');
    expect(prisma.users[0]!.passwordHash).toBe('argon2:NuevaPasswordSegura123');
    expect(prisma.tokens[0]!.usedAt).not.toBeNull();
  });

  it('rechaza si el token no existe', async () => {
    const { service } = makeService();
    await expect(service.reset('a'.repeat(64), 'OtraPasswordSegura123')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza un token ya usado (single-use)', async () => {
    const { service } = makeService();
    const result = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    await service.reset(result!.rawToken, 'NuevaPasswordSegura123');
    await expect(service.reset(result!.rawToken, 'OtraPasswordSegura123')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza un token expirado', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    // Forzamos expiración manualmente.
    prisma.tokens[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(service.reset(result!.rawToken, 'NuevaPasswordSegura123')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  // ── Activación del invitado al estrenar su cuenta ──
  //
  // El invitado que definía su contraseña seguía en PENDING, y `signin` exige
  // ACTIVE: definía la contraseña y AUN ASÍ no entraba hasta que un admin le
  // daba a "Reactivar acceso" a mano.

  it('PENDING sin contraseña → al definirla queda ACTIVE (invitado que estrena cuenta)', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({
      id: 'user-invitado',
      tenantId: 'tenant-1',
      email: 'invitado@example.com',
      name: 'Invitada',
      passwordHash: null,
      status: 'PENDING',
    });
    const result = await service.request(
      { tenantSlug: 'demo', email: 'invitado@example.com' },
      undefined,
      { allowPending: true },
    );
    await service.reset(result!.rawToken, 'NuevaPasswordSegura123');

    const user = prisma.users.find((u) => u.id === 'user-invitado')!;
    expect(user.status).toBe('ACTIVE');
    expect(user.passwordHash).toBe('argon2:NuevaPasswordSegura123');
  });

  it('PENDING CON contraseña → sigue PENDING (la aprobación de inscripción no se salta)', async () => {
    const { service, prisma } = makeService();
    prisma.users.push({
      id: 'user-inscrito',
      tenantId: 'tenant-1',
      email: 'inscrito@example.com',
      name: 'Solicitante',
      // La eligió él mismo al inscribirse; el alta está a la espera del aprobador.
      passwordHash: 'hash-elegido-al-inscribirse',
      status: 'PENDING',
    });
    const result = await service.request(
      { tenantSlug: 'demo', email: 'inscrito@example.com' },
      undefined,
      { allowPending: true },
    );
    await service.reset(result!.rawToken, 'NuevaPasswordSegura123');

    const user = prisma.users.find((u) => u.id === 'user-inscrito')!;
    expect(user.status).toBe('PENDING');
    expect(user.passwordHash).toBe('argon2:NuevaPasswordSegura123');
  });

  it('ACTIVE → el reset normal no toca el status', async () => {
    const { service, prisma } = makeService();
    const result = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    await service.reset(result!.rawToken, 'NuevaPasswordSegura123');
    expect(prisma.users[0]!.status).toBe('ACTIVE');
  });
});

describe('PasswordResetService.buildResetEmail', () => {
  /** Branding de prueba (sin logo salvo que se indique). */
  const branding = (tenantName = 'Didacta', logoUrl: string | null = null) => ({
    tenantName,
    logoUrl,
    brandColor: '#1E5AA8',
  });

  // El idioma del destinatario es OBLIGATORIO en el composer: sin él no se
  // podría saber si un `undefined` es "español" o "se me olvidó pasarlo".
  const ES = 'es-ES';
  const EN = 'en-US';

  it('construye un email con greeting nominal cuando hay name', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('abc123', 'Ana', 'https://didacta.local', branding(), ES);
    expect(out.subject).toBe('Restablecer tu contraseña en Didacta');
    expect(out.text).toContain('Hola Ana');
    expect(out.html).toContain('Hola Ana');
    expect(out.text).toContain('https://didacta.local/reset-password?token=abc123');
    // Firma con el nombre del tenant + footer discreto de plataforma.
    expect(out.text).toContain('— Didacta');
    expect(out.text).toContain('Powered by Didacta');
    expect(out.html).toContain('Powered by Didacta');
  });

  it('cae a un greeting genérico cuando no hay name', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('xyz', null, 'https://x.test', branding(), ES);
    expect(out.text).toContain('Hola,');
    expect(out.html).toContain('Hola,');
  });

  it('encodeURIComponent del token raro', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('a/b+c=', null, 'https://x.test', branding(), ES);
    expect(out.text).toContain('token=a%2Fb%2Bc%3D');
  });

  it('firma con el nombre del tenant + footer Powered by Didacta', () => {
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      'Ana',
      'https://dev.didacta.io',
      branding('Academia Demo'),
      ES,
    );
    expect(out.subject).toBe('Restablecer tu contraseña en Academia Demo');
    expect(out.text).toContain('— Academia Demo');
    expect(out.html).toContain('— Academia Demo');
    expect(out.text).toContain('cuenta en Academia Demo');
    expect(out.text).toContain('Powered by Didacta');
    expect(out.html).toContain('Powered by Didacta');
  });

  it('request() expone tenantName desde el tenant resuelto', async () => {
    const { service } = makeService();
    const result = await service.request({ tenantSlug: 'demo', email: 'ana@example.com' });
    expect(result?.tenantName).toBe('Academia Demo');
  });

  it('embebe el logo del tenant en el header HTML cuando se pasa logoUrl absoluto', () => {
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      'Ana',
      'https://dev.didacta.io',
      branding('Academia Demo', 'https://cdn.didacta.io/logo.png'),
      ES,
    );
    expect(out.html).toContain('<img src="https://cdn.didacta.io/logo.png"');
    expect(out.html).toContain('alt="Academia Demo"');
    // El texto plano no se ve afectado por el logo.
    expect(out.text).not.toContain('<img');
  });

  it('NO renderiza img cuando logoUrl es null (fallback sin romper)', () => {
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      'Ana',
      'https://x.test',
      branding('Academia Demo', null),
      ES,
    );
    expect(out.html).not.toContain('<img');
    expect(out.html).toContain('— Academia Demo');
  });

  it('NO renderiza img cuando logoUrl no es http(s) (defensa anti-inyección)', () => {
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      null,
      'https://x.test',
      branding('Academia Demo', 'javascript:alert(1)'),
      ES,
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
      branding('Acme "Corp" <b>', 'https://cdn.test/l.png'),
      ES,
    );
    expect(out.html).toContain('alt="Acme &quot;Corp&quot; &lt;b&gt;"');
  });

  // ── Idioma del destinatario ────────────────────────────────────────────────
  // El bug: el cuerpo se traducía pero el botón seguía diciendo «Restablecer
  // contraseña». El botón es estructural, así que se le pasaba por alto.

  it('en-US: asunto, cuerpo, título Y BOTÓN en inglés, sin una palabra en español', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('abc', 'Ana', 'https://x.test', branding('Academia'), EN);
    expect(out.subject).toBe('Reset your password at Academia');
    expect(out.text).toContain('Hi Ana,');
    expect(out.text).toContain('We received a request to reset the password');
    // El CTA sale en el texto plano como «label: url» y en el HTML como botón.
    expect(out.text).toContain('Reset password: https://x.test/reset-password?token=abc');
    expect(out.html).toContain('Reset password');
    expect(out.html).toContain('Reset your password');
    for (const spanish of [
      'Restablecer contraseña',
      'Restablecer tu contraseña',
      'Hola',
      'Recibimos una solicitud',
    ]) {
      expect(out.text, `«${spanish}» se coló en el email inglés`).not.toContain(spanish);
      expect(out.html, `«${spanish}» se coló en el HTML inglés`).not.toContain(spanish);
    }
  });

  it('en-US sin nombre: saludo genérico inglés', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('abc', null, 'https://x.test', branding(), EN);
    expect(out.text).toContain('Hi,');
    expect(out.text).not.toContain('Hola,');
  });

  it('el enlace y el token sobreviven igual en inglés', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('a/b+c=', null, 'https://x.test', branding(), EN);
    expect(out.text).toContain('token=a%2Fb%2Bc%3D');
    expect(out.html).toContain('token=a%2Fb%2Bc%3D');
  });

  it('pt-BR: asunto, cuerpo, título Y BOTÓN en portugués, sin español ni inglés', () => {
    // Era el camino degradado de abajo mientras `pt-BR` fue guardable sin
    // catálogo: el usuario brasileño que pedía restablecer su contraseña recibía
    // el correo entero en español.
    const { service } = makeService();
    const out = service.buildResetEmail(
      'abc',
      'Ana',
      'https://x.test',
      branding('Academia'),
      'pt-BR',
    );
    expect(out.subject).toBe('Redefinir sua senha em Academia');
    expect(out.html).toContain('<html lang="pt">');
    expect(out.text).toContain('Olá, Ana!');
    expect(out.text).toContain('Recebemos um pedido para redefinir a senha da sua conta');
    // El CTA sale en el texto plano como «label: url» y en el HTML como botón.
    expect(out.text).toContain('Redefinir senha: https://x.test/reset-password?token=abc');
    expect(out.html).toContain('Redefinir senha');
    expect(out.html).toContain('Redefinir sua senha');
    for (const ajeno of [
      'Restablecer contraseña',
      'Restablecer tu contraseña',
      'Hola',
      'Recibimos una solicitud',
      'Reset password',
      'Hi Ana',
      'We received a request',
    ]) {
      expect(out.text, `«${ajeno}» se coló en el email portugués`).not.toContain(ajeno);
      expect(out.html, `«${ajeno}» se coló en el HTML portugués`).not.toContain(ajeno);
    }
  });

  it('pt-BR sin nombre: saludo genérico portugués', () => {
    const { service } = makeService();
    const out = service.buildResetEmail('abc', null, 'https://x.test', branding(), 'pt-BR');
    expect(out.text).toContain('Olá!');
    expect(out.text).not.toContain('Hola,');
    expect(out.text).not.toContain('Hi,');
  });

  it('CAMINO DEGRADADO: locale sin catálogo (fr-FR), variante regional o vacío → español', () => {
    const { service } = makeService();
    for (const locale of ['fr-FR', 'es-AR', '']) {
      const out = service.buildResetEmail('abc', 'Ana', 'https://x.test', branding(), locale);
      expect(out.subject, locale).toBe('Restablecer tu contraseña en Didacta');
      expect(out.text, locale).toContain('Hola Ana,');
      expect(out.text, locale).toContain('Restablecer contraseña: https://x.test/reset-password');
    }
  });

  it('el override del tenant recibe el CTA en el idioma del destinatario', () => {
    const { service } = makeService();
    const override = { subject: 'Custom {{tenantName}}', body: '{{greeting}} custom body.' };
    const en = service.buildResetEmail('abc', 'Ana', 'https://x.test', branding(), EN, override);
    expect(en.subject).toBe('Custom Didacta');
    expect(en.text).toContain('Hi Ana, custom body.');
    expect(en.text).toContain('Reset password: https://x.test/reset-password?token=abc');

    const es = service.buildResetEmail('abc', 'Ana', 'https://x.test', branding(), ES, override);
    expect(es.text).toContain('Hola Ana, custom body.');
    expect(es.text).toContain('Restablecer contraseña: https://x.test/reset-password?token=abc');
  });

  it('un override SIN asunto cae al asunto por defecto del idioma pedido', () => {
    const { service } = makeService();
    const override = { subject: null, body: 'Body only.' };
    expect(
      service.buildResetEmail('abc', null, 'https://x.test', branding(), EN, override).subject,
    ).toBe('Reset your password at Didacta');
    expect(
      service.buildResetEmail('abc', null, 'https://x.test', branding(), ES, override).subject,
    ).toBe('Restablecer tu contraseña en Didacta');
  });
});
