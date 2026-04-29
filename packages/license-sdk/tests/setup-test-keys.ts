/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Helpers para tests: genera una pareja P-256 efímera, firma un payload con
 * ella y registra la pública en el verifier para que pueda verificarla.
 */

import { generateKeyPair, exportSPKI, exportJWK, SignJWT, type KeyLike } from 'jose';
import { registerPublicKeyForTest, resetPublicKeysCache } from '../src/verifier.js';
import type { LicensePayload } from '../src/types.js';

let cached:
  | { privateKey: KeyLike; publicKey: KeyLike; kid: string }
  | undefined;

export async function getEphemeralKeyPair(kid = 'didacta-test-2026') {
  if (cached) return cached;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  cached = { privateKey, publicKey, kid };
  resetPublicKeysCache();
  registerPublicKeyForTest(kid, publicKey);
  return cached;
}

export async function issueTestLicense(
  partial: Partial<LicensePayload['didacta']> = {},
  options: {
    expiresAt?: Date;
    issuedAt?: Date;
    nbf?: Date;
    issuer?: string;
    audience?: string;
    kid?: string;
  } = {},
): Promise<string> {
  const { privateKey, kid } = await getEphemeralKeyPair(options.kid);
  const now = options.issuedAt ?? new Date();
  const exp = options.expiresAt ?? new Date(now.getTime() + 365 * 86_400_000);

  const payload: LicensePayload = {
    iss: options.issuer ?? 'didacta.io',
    aud: options.audience ?? 'didacta-runtime',
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(exp.getTime() / 1000),
    nbf: options.nbf ? Math.floor(options.nbf.getTime() / 1000) : Math.floor(now.getTime() / 1000),
    sub: 'lic_test',
    didacta: {
      licenseId: partial.licenseId ?? 'lic_test_001',
      customerId: partial.customerId ?? 'cus_test',
      organizationId: partial.organizationId ?? 'org_test',
      organizationName: partial.organizationName ?? 'Test Organization',
      product: 'didacta',
      plan: partial.plan ?? 'enterprise-standard',
      edition: partial.edition ?? 'enterprise',
      issuedAt: now.toISOString(),
      expiresAt: exp.toISOString(),
      gracePeriodDays: partial.gracePeriodDays ?? 30,
      capabilities: partial.capabilities ?? [],
      constraints: partial.constraints,
      support: partial.support,
    },
  };

  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .sign(privateKey);
}
