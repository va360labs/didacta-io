/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * verifier.ts — verifica un JWT firmado con ES256 (ECDSA P-256 + SHA-256)
 * usando la clave pública embebida en src/public-keys/.
 *
 * El issuer real (apps/license-issuer en didacta-cloud) firma con kms:Sign
 * llamando a AWS KMS sobre la key alias/didacta-issuer-2026.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importSPKI, jwtVerify, type KeyLike } from 'jose';
import { licensePayloadSchema, LicenseSignatureError, type LicensePayload } from './types.js';

const ALG = 'ES256';
const EXPECTED_ISSUER = 'didacta.io';
const EXPECTED_AUDIENCE = 'didacta-runtime';

// `__dirname` está disponible directamente en CommonJS (que es lo que el SDK
// compila — alineado con apps/api). Si en el futuro se compila a ESM, sustituir
// por `dirname(fileURLToPath(import.meta.url))`.
const PUBLIC_KEYS_DIR = resolve(__dirname, 'public-keys');

/**
 * Cache de claves públicas indexada por kid. Cargada perezosamente.
 * Cada entry es la Promise<KeyLike> resultante de importSPKI — así el
 * mismo Promise se reusa en consultas concurrentes sin re-importar.
 *
 * Las claves NO son secretos — están publicadas en el repo.
 */
let publicKeysCache: Map<string, Promise<KeyLike>> | null = null;

function loadPublicKeysFromDisk(): Map<string, Promise<KeyLike>> {
  const map = new Map<string, Promise<KeyLike>>();
  if (!existsSync(PUBLIC_KEYS_DIR)) {
    return map;
  }

  const files = readdirSync(PUBLIC_KEYS_DIR).filter((f) => f.endsWith('.pem'));

  for (const filename of files) {
    // El kid es el filename sin extensión, p.ej. "didacta-issuer-2026".
    const kid = filename.replace(/\.pem$/, '');
    const pem = readFileSync(join(PUBLIC_KEYS_DIR, filename), 'utf8');
    map.set(kid, importSPKI(pem, ALG));
  }

  return map;
}

async function getPublicKey(kid: string): Promise<KeyLike> {
  if (!publicKeysCache) {
    publicKeysCache = loadPublicKeysFromDisk();
  }
  const cached = publicKeysCache.get(kid);
  if (!cached) {
    throw new LicenseSignatureError(
      `Unknown key id "${kid}". The license was signed with a key that is not embedded in this build of the SDK. ` +
        `Check that you are running an up-to-date version of Didacta.`,
    );
  }
  return cached;
}

/**
 * Resetea la caché de claves públicas. Útil para tests.
 */
export function resetPublicKeysCache(): void {
  publicKeysCache = null;
}

/**
 * Permite inyectar claves públicas adicionales (útil para tests con keys ad-hoc).
 */
export function registerPublicKeyForTest(kid: string, key: KeyLike): void {
  if (!publicKeysCache) {
    publicKeysCache = loadPublicKeysFromDisk();
  }
  publicKeysCache.set(kid, Promise.resolve(key));
}

interface VerifyOptions {
  /** Allow verification even if iat is in the future (clock skew). Default 30s. */
  clockToleranceSeconds?: number;
  /** Override expected issuer (for tests). */
  issuer?: string;
  /** Override expected audience (for tests). */
  audience?: string;
}

/**
 * Verifica un JWT y devuelve el payload tipado.
 * Lanza LicenseSignatureError si la firma es inválida o el payload está malformado.
 */
export async function verifyLicense(
  token: string,
  options: VerifyOptions = {},
): Promise<LicensePayload> {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new LicenseSignatureError('Empty license token.');
  }

  const headerB64 = token.split('.')[0];
  if (!headerB64) {
    throw new LicenseSignatureError('Malformed JWT (no header).');
  }

  let header: { kid?: string; alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    throw new LicenseSignatureError('Malformed JWT header.');
  }

  if (header.alg !== ALG) {
    throw new LicenseSignatureError(`Unsupported algorithm "${header.alg}". Expected "${ALG}".`);
  }

  if (!header.kid) {
    throw new LicenseSignatureError('JWT header missing "kid". Cannot identify signing key.');
  }

  const publicKey = await getPublicKey(header.kid);

  let payload: unknown;
  try {
    const result = await jwtVerify(token, publicKey, {
      algorithms: [ALG],
      issuer: options.issuer ?? EXPECTED_ISSUER,
      audience: options.audience ?? EXPECTED_AUDIENCE,
      clockTolerance: `${options.clockToleranceSeconds ?? 30}s`,
    });
    payload = result.payload;
  } catch (err) {
    throw new LicenseSignatureError(`JWT verification failed: ${(err as Error).message}`);
  }

  const parsed = licensePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new LicenseSignatureError(`License payload schema invalid: ${parsed.error.message}`);
  }

  return parsed.data;
}
