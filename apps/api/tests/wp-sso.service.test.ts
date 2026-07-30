import { sessionRegistryStub } from './helpers/session-registry-stub';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WpSsoTokenError } from '@didacta/mod-wp-sso';
import { WpSsoService } from '../src/sso/wp/wp-sso.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { TokenService } from '../src/auth/token.service';
import type { PrismaAuditLogService } from '../src/modules/prisma-audit-log.service';
import type { WpSsoConfigService } from '../src/sso/wp/wp-sso-config.service';

const SECRET = 'wp-sso-secreto-compartido-de-prueba-1234567890';
const TENANT_SLUG = 'va360';

function makeToken(
  opts: {
    email?: string;
    name?: string;
    jti?: string;
    ttl?: number;
    sub?: string;
    emailVerified?: boolean;
    secret?: string;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: opts.email ?? 'nuevo@va360.academy',
    ...(opts.name ? { name: opts.name } : {}),
    jti: opts.jti ?? `jti-${Math.floor(now)}-${opts.email ?? 'x'}`,
    ...(opts.sub ? { sub: opts.sub } : {}),
    ...(opts.emailVerified !== undefined ? { email_verified: opts.emailVerified } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttl ?? 120))
    .setAudience('didacta-wp-sso')
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    sharedSecret: SECRET,
    issuer: undefined,
    audience: undefined,
    autoCreate: true,
    autoRedirect: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

interface Mocks {
  prisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    role: { findFirst: ReturnType<typeof vi.fn> };
    userExternalIdentity: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  tokens: { sign: ReturnType<typeof vi.fn> };
  auditLog: { record: ReturnType<typeof vi.fn> };
  config: { resolveTenantConfig: ReturnType<typeof vi.fn> };
}

function build(configOverrides: Record<string, unknown> = {}): { svc: WpSsoService; m: Mocks } {
  const m: Mocks = {
    prisma: {
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'user-new',
          email: 'nuevo@va360.academy',
          name: 'Nuevo',
          status: 'ACTIVE',
          roles: [{ role: { name: 'alumno' } }],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      role: { findFirst: vi.fn().mockResolvedValue({ id: 'role-alumno' }) },
      userExternalIdentity: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'idn-new' }),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    tokens: { sign: vi.fn().mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' }) },
    auditLog: { record: vi.fn().mockResolvedValue(undefined) },
    config: {
      resolveTenantConfig: vi.fn().mockResolvedValue({
        tenant: { id: 'tenant-1', slug: TENANT_SLUG },
        config: makeConfig(configOverrides),
      }),
    },
  };
  const svc = new WpSsoService(
    m.prisma as unknown as PrismaService,
    m.tokens as unknown as TokenService,
    m.auditLog as unknown as PrismaAuditLogService,
    m.config as unknown as WpSsoConfigService,
    sessionRegistryStub(m.tokens as never),
  );
  return { svc, m };
}

describe('WpSsoService.exchange', () => {
  beforeEach(() => {
    delete process.env['REDIS_URL']; // fuerza el anti-replay in-memory
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('not_configured si el tenant no está configurado/habilitado', async () => {
    const { svc, m } = build();
    m.config.resolveTenantConfig.mockRejectedValue(
      new WpSsoTokenError('not_configured', 'WP-SSO no configurado para este tenant.'),
    );
    await expect(svc.exchange(TENANT_SLUG, await makeToken())).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('auto-crea el usuario (rol alumno) y emite sesión', async () => {
    const { svc, m } = build();
    const out = await svc.exchange(
      TENANT_SLUG,
      await makeToken({ email: 'nuevo@va360.academy', name: 'Nuevo' }),
    );
    expect(m.prisma.user.create).toHaveBeenCalledTimes(1);
    const createArg = m.prisma.user.create.mock.calls[0][0];
    expect(createArg.data.roles.create.roleId).toBe('role-alumno');
    expect(out.tokens).toEqual({ accessToken: 'AT', refreshToken: 'RT' });
    expect(out.user.roles).toContain('alumno');
    expect(out.user.tenantSlug).toBe(TENANT_SLUG);
    expect(m.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sso.wp.user.provisioned' }),
    );
  });

  it('usuario existente activo → update lastLogin + sesión (no create)', async () => {
    const { svc, m } = build();
    m.prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'existe@va360.academy',
      name: 'Existe',
      status: 'ACTIVE',
      roles: [{ role: { name: 'alumno' } }],
    });
    const out = await svc.exchange(TENANT_SLUG, await makeToken({ email: 'existe@va360.academy' }));
    expect(m.prisma.user.create).not.toHaveBeenCalled();
    expect(m.prisma.user.update).toHaveBeenCalledTimes(1);
    expect(out.user.id).toBe('user-1');
  });

  it('rechaza autoCreate=false (config) si el usuario no existe', async () => {
    const { svc } = build({ autoCreate: false });
    await expect(svc.exchange(TENANT_SLUG, await makeToken())).rejects.toThrow(/No tienes cuenta/);
  });

  it('anti-replay: el mismo token (jti) no se puede usar dos veces', async () => {
    const { svc } = build();
    const token = await makeToken({ jti: 'jti-fijo-replay' });
    await svc.exchange(TENANT_SLUG, token); // 1ª vez OK
    await expect(svc.exchange(TENANT_SLUG, token)).rejects.toMatchObject({ code: 'replayed' });
  });

  it('rechaza firma inválida (secreto distinto al de la config)', async () => {
    const { svc } = build();
    const bad = await makeToken({ secret: 'secreto-equivocado-aaaaaaaaaaaaaaaaaaaa' });
    await expect(svc.exchange(TENANT_SLUG, bad)).rejects.toBeInstanceOf(WpSsoTokenError);
  });

  it('con sub: provisión crea identidad estable (linkMethod auto_provision)', async () => {
    const { svc, m } = build();
    await svc.exchange(
      TENANT_SLUG,
      await makeToken({ email: 'nuevo@va360.academy', sub: 'wp-100' }),
    );
    expect(m.prisma.userExternalIdentity.findUnique).toHaveBeenCalledTimes(1);
    expect(m.prisma.user.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.userExternalIdentity.create).toHaveBeenCalledTimes(1);
    const linkArg = m.prisma.userExternalIdentity.create.mock.calls[0][0];
    expect(linkArg.data.externalId).toBe('wp-100');
    expect(linkArg.data.provider).toBe('wp');
    expect(linkArg.data.linkMethod).toBe('auto_provision');
  });

  it('con sub: identidad existente resuelve por sub (sin create ni provisión)', async () => {
    const { svc, m } = build();
    m.prisma.userExternalIdentity.findUnique.mockResolvedValue({ id: 'idn-1', userId: 'user-7' });
    m.prisma.user.findUnique.mockResolvedValue({
      id: 'user-7',
      email: 'ana@va360.academy',
      name: 'Ana',
      status: 'ACTIVE',
      roles: [{ role: { name: 'alumno' } }],
    });
    const out = await svc.exchange(
      TENANT_SLUG,
      await makeToken({ email: 'ana@va360.academy', sub: 'wp-7' }),
    );
    expect(m.prisma.user.create).not.toHaveBeenCalled();
    expect(m.prisma.userExternalIdentity.create).not.toHaveBeenCalled();
    expect(m.prisma.userExternalIdentity.update).toHaveBeenCalledTimes(1); // refresca lastSeenAt
    expect(out.user.id).toBe('user-7');
  });

  it('con sub: usuario existente por email se vincula lazy (linkMethod auto_email)', async () => {
    const { svc, m } = build();
    m.prisma.user.findUnique.mockResolvedValue({
      id: 'user-9',
      email: 'pepe@va360.academy',
      name: 'Pepe',
      status: 'ACTIVE',
      roles: [{ role: { name: 'alumno' } }],
    });
    const out = await svc.exchange(
      TENANT_SLUG,
      await makeToken({ email: 'pepe@va360.academy', sub: 'wp-9' }),
    );
    expect(m.prisma.user.create).not.toHaveBeenCalled();
    expect(m.prisma.userExternalIdentity.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.userExternalIdentity.create.mock.calls[0][0].data.linkMethod).toBe(
      'auto_email',
    );
    expect(out.user.id).toBe('user-9');
    expect(m.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sso.wp.account.linked' }),
    );
  });

  it('un usuario PENDING no entra por SSO (status != ACTIVE)', async () => {
    const { svc, m } = build();
    m.prisma.user.findUnique.mockResolvedValue({
      id: 'user-p',
      email: 'pending@va360.academy',
      name: 'Pend',
      status: 'PENDING',
      roles: [],
    });
    await expect(
      svc.exchange(TENANT_SLUG, await makeToken({ email: 'pending@va360.academy', sub: 'wp-p' })),
    ).rejects.toThrow(/no está activa/);
    expect(m.prisma.userExternalIdentity.create).not.toHaveBeenCalled();
  });
});
