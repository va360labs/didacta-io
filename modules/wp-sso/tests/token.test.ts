import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { WpSsoTokenError } from '../src/errors.js';
import { verifyWpSsoToken, WP_SSO_DEFAULT_AUDIENCE } from '../src/token.js';

const SECRET = 'shared-secret-de-prueba-bastante-largo-1234567890';
const ISS = 'https://wp.example.com';

function enc(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Firma un token tipo-WordPress con control fino de iat/exp/aud/iss/claims. */
async function makeToken(
  opts: {
    secret?: string;
    email?: unknown;
    name?: string;
    jti?: string | null;
    aud?: string;
    iss?: string;
    sub?: string | null;
    emailVerified?: unknown;
    iatOffset?: number; // segundos respecto a "ahora"
    ttl?: number; // exp - iat
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = now + (opts.iatOffset ?? 0);
  const exp = iat + (opts.ttl ?? 120);
  const builder = new SignJWT({
    ...(opts.email !== undefined ? { email: opts.email } : { email: 'alumno@example.com' }),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.jti === null ? {} : { jti: opts.jti ?? 'nonce-unico-1' }),
    ...(opts.sub === null ? {} : { sub: opts.sub ?? 'wp-42' }),
    ...(opts.emailVerified !== undefined ? { email_verified: opts.emailVerified } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setAudience(opts.aud ?? WP_SSO_DEFAULT_AUDIENCE);
  if (opts.iss ?? ISS) builder.setIssuer(opts.iss ?? ISS);
  return builder.sign(enc(opts.secret ?? SECRET));
}

describe('verifyWpSsoToken', () => {
  it('acepta un token válido y devuelve email normalizado + jti + name + sub', async () => {
    const token = await makeToken({
      email: 'Alumno@Example.Com',
      name: 'Ana Pérez',
      sub: 'wp-7',
    });
    const claims = await verifyWpSsoToken(token, { sharedSecret: SECRET, expectedIssuer: ISS });
    expect(claims.email).toBe('alumno@example.com'); // trim + lowercase
    expect(claims.name).toBe('Ana Pérez');
    expect(claims.jti).toBe('nonce-unico-1');
    expect(claims.iss).toBe(ISS);
    expect(claims.subject).toBe('wp-7');
    expect(claims.emailVerified).toBe(false); // ausente → no verificado
    expect(typeof claims.exp).toBe('number');
  });

  it('parsea email_verified=true solo cuando es el booleano true', async () => {
    const verificado = await makeToken({ emailVerified: true });
    expect((await verifyWpSsoToken(verificado, { sharedSecret: SECRET })).emailVerified).toBe(true);
    // "true" string NO cuenta como verificado (defensa contra coerción).
    const stringTrue = await makeToken({ emailVerified: 'true' });
    expect((await verifyWpSsoToken(stringTrue, { sharedSecret: SECRET })).emailVerified).toBe(
      false,
    );
  });

  it('subject undefined si el token es legacy 0.1.0 (sin sub)', async () => {
    const legacy = await makeToken({ sub: null });
    const claims = await verifyWpSsoToken(legacy, { sharedSecret: SECRET });
    expect(claims.subject).toBeUndefined();
  });

  it('rechaza firma inválida (secreto distinto)', async () => {
    const token = await makeToken({ secret: 'otro-secreto-totalmente-distinto-0987654321' });
    await expect(verifyWpSsoToken(token, { sharedSecret: SECRET })).rejects.toMatchObject({
      code: 'bad_signature',
    });
  });

  it('rechaza token expirado', async () => {
    const token = await makeToken({ iatOffset: -600, ttl: 120 }); // exp hace ~8 min
    await expect(
      verifyWpSsoToken(token, { sharedSecret: SECRET, clockToleranceSeconds: 5 }),
    ).rejects.toMatchObject({ code: 'expired' });
  });

  it('rechaza audiencia incorrecta', async () => {
    const token = await makeToken({ aud: 'otra-audiencia' });
    await expect(verifyWpSsoToken(token, { sharedSecret: SECRET })).rejects.toMatchObject({
      code: 'audience_invalid',
    });
  });

  it('rechaza issuer distinto del configurado', async () => {
    const token = await makeToken({ iss: 'https://atacante.example' });
    await expect(
      verifyWpSsoToken(token, { sharedSecret: SECRET, expectedIssuer: ISS }),
    ).rejects.toMatchObject({ code: 'issuer_invalid' });
  });

  it('rechaza TTL demasiado largo (defensa anti token longevo)', async () => {
    const token = await makeToken({ ttl: 3600 }); // 1h > 300s default
    await expect(verifyWpSsoToken(token, { sharedSecret: SECRET })).rejects.toMatchObject({
      code: 'ttl_too_long',
    });
  });

  it('rechaza sin jti (necesario para anti-replay)', async () => {
    const token = await makeToken({ jti: null });
    await expect(verifyWpSsoToken(token, { sharedSecret: SECRET })).rejects.toMatchObject({
      code: 'claim_invalid',
    });
  });

  it('rechaza email ausente o inválido', async () => {
    const noEmail = await makeToken({ email: '' });
    await expect(verifyWpSsoToken(noEmail, { sharedSecret: SECRET })).rejects.toMatchObject({
      code: 'email_invalid',
    });
    const badEmail = await makeToken({ email: 'no-es-un-email' });
    await expect(verifyWpSsoToken(badEmail, { sharedSecret: SECRET })).rejects.toMatchObject({
      code: 'email_invalid',
    });
  });

  it('rechaza si falta el secreto compartido en Didacta (not_configured)', async () => {
    const token = await makeToken();
    await expect(verifyWpSsoToken(token, { sharedSecret: '' })).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('rechaza token vacío (missing_token)', async () => {
    await expect(verifyWpSsoToken('', { sharedSecret: SECRET })).rejects.toBeInstanceOf(
      WpSsoTokenError,
    );
  });
});
