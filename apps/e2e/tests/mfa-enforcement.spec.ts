import { expect, test } from '@playwright/test';
import { authenticator } from 'otplib';
import { API_URL, signin } from '../helpers/api';

/**
 * Spec del enforcement MFA para roles administrativos (LMS-109).
 *
 * Caso bajo prueba:
 *   1. Admin hace signin → recibe `mfaRequired: true` y un access token
 *      con `mfaVerified: false`.
 *   2. Pegar a un endpoint admin con ese token NO verificado debe fallar
 *      con 403 + body { code: 'mfa_required' }.
 *   3. Endpoints exentos (/me/profile, /auth/mfa/*) sí responden con ese
 *      token — son los que el cliente necesita para completar el setup.
 *   4. Tras correr el flow setup → enable, el nuevo token resultante sí
 *      pasa el guard y el endpoint admin responde 200.
 *
 * Sin esta enforcement un admin con sesión sin verificar podía llamar
 * cualquier endpoint admin con sólo el access token — el bypass que
 * cierra esta historia.
 */

interface MfaSetupResponse {
  otpauthUrl: string;
}

interface MfaEnableResponse {
  enabled: true;
  tokens: { accessToken: string };
}

async function postJson<T>(path: string, body: unknown, bearer: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

test.describe('Auth · MFA enforcement (LMS-109)', () => {
  test('admin sin mfaVerified queda bloqueado en endpoint admin hasta completar setup', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminEmail = process.env.E2E_ADMIN_EMAIL;
    const adminPassword = process.env.E2E_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      throw new Error('E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD requeridos.');
    }

    // 1) Signin sin completar MFA
    const session = await signin({ tenantSlug, email: adminEmail, password: adminPassword });
    expect(session.mfaRequired, 'admin debe requerir MFA').toBe(true);
    const bearer = session.tokens.accessToken;

    // 2) Llamada a endpoint admin → 403 con code=mfa_required.
    //    Usamos /admin/system/health-detail por ser estable y barato.
    const blocked = await fetch(`${API_URL}/api/v1/admin/system/health-detail`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(blocked.status, 'endpoint admin sin mfaVerified → 403').toBe(403);
    const blockedBody = (await blocked.json()) as { code?: string; message?: string };
    expect(blockedBody.code, 'el body debe incluir code mfa_required').toBe('mfa_required');

    // 3) Endpoints exentos del enforcement deben seguir funcionando con el
    //    mismo token: el cliente los necesita para mostrar el flow MFA.
    const profile = await fetch(`${API_URL}/api/v1/me/profile`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(profile.status, '/me/profile es exento (lo necesita el flujo MFA)').toBe(200);

    // 4) Completar setup → enable y reusar el token elevado.
    const setup = await postJson<MfaSetupResponse>('/api/v1/auth/mfa/setup', {}, bearer);
    const secret = setup.otpauthUrl.match(/[?&]secret=([^&]+)/)?.[1];
    expect(secret, 'el secret base32 viene en otpauthUrl').toBeTruthy();
    const code = authenticator.generate(decodeURIComponent(secret!));
    const enabled = await postJson<MfaEnableResponse>('/api/v1/auth/mfa/enable', { code }, bearer);
    expect(enabled.enabled).toBe(true);

    // 5) El token elevado pasa el guard y el endpoint admin responde 200.
    const allowed = await fetch(`${API_URL}/api/v1/admin/system/health-detail`, {
      headers: { Authorization: `Bearer ${enabled.tokens.accessToken}` },
    });
    expect(allowed.status, 'tras enable, el endpoint admin responde 200').toBe(200);
  });
});
