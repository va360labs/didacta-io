/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Helper de tests de integración (MIG-034).
 *
 * Genera JWTs ES256 firmados con un par de claves efímero P-256 que se inyecta
 * en la caché del verifier vía `registerPublicKeyForTest`. Replica el patrón
 * de `packages/license-sdk/tests/setup-test-keys.ts` pero vivo en `apps/api/`
 * para no tocar el SDK (regla dura de MIG-034).
 *
 * Importante: el SDK valida iss = "didacta.io", aud = "didacta-runtime" y
 * algoritmo ES256. Cualquier override aquí solo aplica para los tests de
 * camino "invalid".
 */

import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { registerPublicKeyForTest, resetPublicKeysCache } from '@didacta/license-sdk';
import { LICENSE_CAPABILITIES } from '@didacta/license-sdk';

const PRIMARY_KID = 'didacta-test-2026';
const ROGUE_KID = 'didacta-rogue-2026';

interface KeyPair {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

let primaryCache: KeyPair | null = null;
let rogueCache: KeyPair | null = null;

/**
 * Devuelve (y cachea) la pareja primaria — la que el verifier confía. Cualquier
 * JWT firmado con ella verificará correctamente la firma; el resto de claims
 * pueden hacerlo caer al estado `invalid` o `expired` igualmente.
 */
async function getPrimaryKeyPair(): Promise<KeyPair> {
  if (primaryCache) return primaryCache;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  primaryCache = { privateKey, publicKey, publicJwk, kid: PRIMARY_KID };
  resetPublicKeysCache();
  registerPublicKeyForTest(PRIMARY_KID, publicKey);
  return primaryCache;
}

/**
 * Devuelve una pareja "rogue" — privada distinta cuya pública NO se registra
 * en el verifier. Cualquier JWT firmado con ella reportará `Unknown key id`
 * y el SDK lo marca como `invalid`.
 *
 * El kid del header se setea al kid primario (`didacta-test-2026`), de modo
 * que el verifier intente usar la clave registrada — y la firma falla porque
 * fue creada por otra privada distinta. Esto reproduce el ataque "alguien
 * firma con su key + reusa nuestro kid público".
 */
async function getRogueKeyPair(): Promise<KeyPair> {
  if (rogueCache) return rogueCache;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  rogueCache = { privateKey, publicKey, publicJwk, kid: ROGUE_KID };
  return rogueCache;
}

export interface IssueOptions {
  capabilities?: readonly string[];
  organizationName?: string;
  plan?: string;
  expiresAt?: Date;
  issuedAt?: Date;
  gracePeriodDays?: number;
  /** Override iss (para tests de signature inválida). */
  issuer?: string;
  /** Override aud. */
  audience?: string;
  /**
   * Si `true`, firma con la pareja "rogue" pero pone el kid primario en el
   * header. El SDK lo trata como `invalid` (firma no verifica).
   */
  signWithRogueKey?: boolean;
  /**
   * Override del claim `exp` del JWT estándar (separado del `didacta.expiresAt`
   * interno). Útil para probar el comportamiento de grace: el JWT estándar
   * sigue válido (jose no lo rechaza) mientras que `didacta.expiresAt` está
   * en pasado, lo que permite que el runtime calcule status `grace` o
   * `expired` correctamente.
   *
   * Si se omite, `exp` JWT == `expiresAt` didacta (comportamiento original).
   */
  jwtExpiresAt?: Date;
}

/**
 * Construye y firma un JWT de licencia para tests. Devuelve el token compactado.
 */
export async function issueTestLicense(opts: IssueOptions = {}): Promise<string> {
  const primary = await getPrimaryKeyPair();
  const signingKp = opts.signWithRogueKey ? await getRogueKeyPair() : primary;

  const now = opts.issuedAt ?? new Date();
  const exp = opts.expiresAt ?? new Date(now.getTime() + 365 * 86_400_000);
  // El claim `exp` del JWT solo controla la validación de jose (clockTolerance
  // 30s default). Para probar grace, conviene desacoplarlo de `didacta.expiresAt`:
  // exp JWT en futuro lejano (jose acepta) + didacta.expiresAt en pasado
  // (runtime calcula grace). Si el caller no override, mantener compatibilidad:
  // exp JWT == didacta.expiresAt.
  const jwtExp = opts.jwtExpiresAt ?? exp;

  const payload = {
    iss: opts.issuer ?? 'didacta.io',
    aud: opts.audience ?? 'didacta-runtime',
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(jwtExp.getTime() / 1000),
    nbf: Math.floor(now.getTime() / 1000),
    sub: 'lic_integration_test',
    didacta: {
      licenseId: 'lic_integration_test_001',
      customerId: 'cus_integration_test',
      organizationId: 'org_integration_test',
      organizationName: opts.organizationName ?? 'Integration Test Org',
      product: 'didacta',
      plan: opts.plan ?? 'enterprise-standard',
      edition: 'enterprise',
      issuedAt: now.toISOString(),
      expiresAt: exp.toISOString(),
      gracePeriodDays: opts.gracePeriodDays ?? 30,
      capabilities: [...(opts.capabilities ?? [])],
    },
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: primary.kid, typ: 'JWT' })
    .sign(signingKp.privateKey);
}

/**
 * Conjunto completo de licencias canónicas para los tests del LicenseGuard.
 *
 * Se generan en runtime (no se persisten en disco) porque las firmas dependen
 * de la pareja efímera generada en cada arranque del test. Si en el futuro
 * decides persistir fixtures, deberás también persistir la clave pública
 * correspondiente y registrarla en el verifier antes de cada test.
 */
export async function issueCanonicalLicenses(now = new Date()) {
  return {
    validWithWhiteLabel: await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.WHITE_LABEL],
      organizationName: 'Acme White Label',
      plan: 'enterprise-standard',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 90 * 86_400_000),
    }),
    validWithoutWhiteLabel: await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.SCIM],
      organizationName: 'Acme No White Label',
      plan: 'enterprise-standard',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 90 * 86_400_000),
    }),
    expired: await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.WHITE_LABEL],
      organizationName: 'Acme Expired',
      // 100 días atrás, gracia 30 → estado `expired` (post-grace).
      issuedAt: new Date(now.getTime() - 200 * 86_400_000),
      expiresAt: new Date(now.getTime() - 100 * 86_400_000),
      gracePeriodDays: 30,
    }),
    invalidSignature: await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.WHITE_LABEL],
      organizationName: 'Acme Rogue',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 90 * 86_400_000),
      signWithRogueKey: true,
    }),
  };
}

export { PRIMARY_KID, ROGUE_KID };
