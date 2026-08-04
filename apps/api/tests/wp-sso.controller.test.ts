import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WpSsoTokenError } from '@didacta/mod-wp-sso';
import { WpSsoController } from '../src/sso/wp/wp-sso.controller';
import type { WpSsoService } from '../src/sso/wp/wp-sso.service';
import type { WpSsoConfigService } from '../src/sso/wp/wp-sso-config.service';
import { TenantResolverService } from '../src/tenancy/tenant-resolver.service';

/** FastifyReply mínimo que captura status + URL del redirect. */
function fakeRes() {
  const captured: { status?: number; url?: string } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    redirect(url: string) {
      captured.url = url;
      return res;
    },
  };
  return { res, captured };
}

function fakeReq(headers: Record<string, string | string[] | undefined> = {}) {
  return { headers, protocol: 'https' };
}

const OK_RESULT = {
  tokens: { accessToken: 'AT', refreshToken: 'RT' },
  user: {
    id: 'user-1',
    email: 'ana@example.com',
    name: 'Ana',
    tenantId: 'tenant-1',
    tenantSlug: 'demo',
    roles: ['alumno'],
  },
};

function build(
  svcOverrides: Partial<{ exchange: ReturnType<typeof vi.fn> }> = {},
  configOverrides: Partial<{ getPublicStatus: ReturnType<typeof vi.fn> }> = {},
) {
  const wpSso = { exchange: vi.fn().mockResolvedValue(OK_RESULT), ...svcOverrides };
  const config = {
    getPublicStatus: vi.fn().mockResolvedValue({
      configured: true,
      autoRedirect: true,
      wordpressUrl: 'https://wp.example.com',
    }),
    ...configOverrides,
  };
  // Servicio REAL (no mock manual): 'demo' no es un tenant real en este
  // harness, así que resolveBySlug cae a null y el comportamiento de la
  // cascada queda idéntico al de antes de F5 (env → allowlist → localhost).
  const tenantResolver = new TenantResolverService({
    tenant: { findUnique: vi.fn().mockResolvedValue(null) },
    tenantDomain: { findFirst: vi.fn().mockResolvedValue(null) },
  } as never);
  const ctrl = new WpSsoController(
    wpSso as unknown as WpSsoService,
    config as unknown as WpSsoConfigService,
    tenantResolver,
  );
  return { ctrl, wpSso, config };
}

describe('WpSsoController', () => {
  const ORIGINAL = process.env.WEB_PUBLIC_URL;
  beforeEach(() => {
    process.env.WEB_PUBLIC_URL = 'https://aula.example.com';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WEB_PUBLIC_URL;
    else process.env.WEB_PUBLIC_URL = ORIGINAL;
  });

  it('status: delega en config.getPublicStatus(tenantSlug)', async () => {
    const { ctrl, config } = build();
    const out = await ctrl.status('demo');
    expect(config.getPublicStatus).toHaveBeenCalledWith('demo');
    expect(out).toMatchObject({ configured: true, autoRedirect: true });
  });

  it('callback éxito: pasa el tenantSlug a exchange y redirige con el set completo', async () => {
    const { ctrl, wpSso } = build();
    const { res, captured } = fakeRes();

    await ctrl.callback('demo', 'token-123', fakeReq() as never, res as never);

    expect(wpSso.exchange).toHaveBeenCalledWith('demo', 'token-123');
    expect(captured.status).toBe(302);
    const url = new URL(captured.url!);
    expect(url.origin + url.pathname).toBe('https://aula.example.com/auth/callback');
    expect(url.searchParams.get('accessToken')).toBe('AT');
    expect(url.searchParams.get('userId')).toBe('user-1');
    expect(url.searchParams.get('email')).toBe('ana@example.com');
    expect(url.searchParams.get('tenantId')).toBe('tenant-1');
    expect(url.searchParams.get('tenantSlug')).toBe('demo');
    expect(url.searchParams.get('roles')).toBe('alumno');
    expect(url.searchParams.get('mfaEnabled')).toBe('true');
  });

  it('callback error de token: redirige a /auth/error con el code como reason', async () => {
    const { ctrl } = build({
      exchange: vi.fn().mockRejectedValue(new WpSsoTokenError('expired', 'El enlace SSO expiró.')),
    });
    const { res, captured } = fakeRes();

    await ctrl.callback('demo', 'token-viejo', fakeReq() as never, res as never);

    expect(captured.status).toBe(302);
    const url = new URL(captured.url!);
    expect(url.origin + url.pathname).toBe('https://aula.example.com/auth/error');
    expect(url.searchParams.get('reason')).toBe('expired');
  });

  it('SEGURIDAD: sin WEB_PUBLIC_URL, un Host atacante NO recibe los tokens', async () => {
    delete process.env.WEB_PUBLIC_URL;
    const { ctrl } = build();
    const { res, captured } = fakeRes();

    await ctrl.callback(
      'demo',
      'token-123',
      fakeReq({ 'x-forwarded-host': 'atacante.evil' }) as never,
      res as never,
    );

    const url = new URL(captured.url!);
    expect(url.host).not.toBe('atacante.evil');
    expect(url.host).toBe('localhost:3000');
  });
});
