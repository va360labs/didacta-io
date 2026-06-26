import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WpSsoTokenError } from '@didacta/mod-wp-sso';
import { WpSsoController } from '../src/sso/wp/wp-sso.controller';
import type { WpSsoService } from '../src/sso/wp/wp-sso.service';

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
    email: 'ana@va360.academy',
    name: 'Ana',
    tenantId: 'tenant-1',
    tenantSlug: 'va360',
    roles: ['alumno'],
  },
};

describe('WpSsoController.callback', () => {
  const ORIGINAL = process.env.WEB_PUBLIC_URL;

  beforeEach(() => {
    process.env.WEB_PUBLIC_URL = 'https://aula.va360.academy';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WEB_PUBLIC_URL;
    else process.env.WEB_PUBLIC_URL = ORIGINAL;
  });

  it('éxito: redirige a /auth/callback con el set COMPLETO de params (no solo tokens)', async () => {
    const svc = { exchange: vi.fn().mockResolvedValue(OK_RESULT) };
    const ctrl = new WpSsoController(svc as unknown as WpSsoService);
    const { res, captured } = fakeRes();

    await ctrl.callback('token-123', fakeReq() as never, res as never);

    expect(captured.status).toBe(302);
    const url = new URL(captured.url!);
    expect(url.origin + url.pathname).toBe('https://aula.va360.academy/auth/callback');
    expect(url.searchParams.get('accessToken')).toBe('AT');
    expect(url.searchParams.get('refreshToken')).toBe('RT');
    // Estos 4 son los que faltaban y dejaban el flujo roto: el handler del front
    // (oidc-callback-handler.tsx:39) aborta a /auth/error sin ellos.
    expect(url.searchParams.get('userId')).toBe('user-1');
    expect(url.searchParams.get('email')).toBe('ana@va360.academy');
    expect(url.searchParams.get('tenantId')).toBe('tenant-1');
    expect(url.searchParams.get('tenantSlug')).toBe('va360');
    expect(url.searchParams.get('roles')).toBe('alumno');
    expect(url.searchParams.get('name')).toBe('Ana');
    expect(url.searchParams.get('mfaEnabled')).toBe('true');
  });

  it('error de token: redirige a /auth/error con el code como reason', async () => {
    const svc = {
      exchange: vi.fn().mockRejectedValue(new WpSsoTokenError('expired', 'El enlace SSO expiró.')),
    };
    const ctrl = new WpSsoController(svc as unknown as WpSsoService);
    const { res, captured } = fakeRes();

    await ctrl.callback('token-viejo', fakeReq() as never, res as never);

    expect(captured.status).toBe(302);
    const url = new URL(captured.url!);
    expect(url.origin + url.pathname).toBe('https://aula.va360.academy/auth/error');
    expect(url.searchParams.get('reason')).toBe('expired');
  });

  it('SEGURIDAD: sin WEB_PUBLIC_URL, un Host atacante NO recibe los tokens', async () => {
    delete process.env.WEB_PUBLIC_URL;
    const svc = { exchange: vi.fn().mockResolvedValue(OK_RESULT) };
    const ctrl = new WpSsoController(svc as unknown as WpSsoService);
    const { res, captured } = fakeRes();

    await ctrl.callback(
      'token-123',
      fakeReq({ 'x-forwarded-host': 'atacante.evil' }) as never,
      res as never,
    );

    const url = new URL(captured.url!);
    expect(url.host).not.toBe('atacante.evil');
    expect(url.host).toBe('localhost:3000');
  });
});
