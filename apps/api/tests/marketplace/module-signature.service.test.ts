import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { MarketplacePackageError } from '../../src/marketplace/module-package.errors';
import {
  MARKETPLACE_AUDIENCE,
  MARKETPLACE_ISSUER,
  ModuleSignatureService,
} from '../../src/marketplace/module-signature.service';
import { baseManifest, buildTestPackage, generateTestKeypair } from './fixtures/build-test-package';

function makeService(): ModuleSignatureService {
  const svc = new ModuleSignatureService();
  svc.onModuleInit();
  return svc;
}

async function signWith(
  manifest: typeof baseManifest,
  options: {
    privateKey?: import('jose').KeyLike;
    kid?: string;
    issuer?: string;
    audience?: string;
  } = {},
): Promise<{ token: string; publicKey: import('jose').KeyLike; kid: string }> {
  const keys = options.privateKey
    ? { privateKey: options.privateKey, publicKey: undefined as unknown as import('jose').KeyLike }
    : await generateKeyPair('ES256');
  const kid = options.kid ?? 'didacta-test-key';
  const token = await new SignJWT(manifest as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(options.issuer ?? MARKETPLACE_ISSUER)
    .setAudience(options.audience ?? MARKETPLACE_AUDIENCE)
    .setIssuedAt()
    .sign(keys.privateKey);
  return { token, publicKey: keys.publicKey, kid };
}

describe('ModuleSignatureService.verifyManifestJwt', () => {
  it('acepta un JWT firmado con la clave registrada', async () => {
    const svc = makeService();
    const fixture = await buildTestPackage({ signatureService: svc });
    const manifest = await svc.verifyManifestJwt(fixture.manifestJwt);
    expect(manifest.name).toBe('mod.example');
    expect(manifest.vendor).toBe('didacta');
  });

  it('SIGNATURE_INVALID si el token está vacío', async () => {
    const svc = makeService();
    await expect(svc.verifyManifestJwt('')).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('SIGNATURE_INVALID si el token no es un JWT', async () => {
    const svc = makeService();
    await expect(svc.verifyManifestJwt('no-soy-un-jwt')).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
  });

  it('SIGNATURE_VERIFY_FAILED si el kid no está registrado', async () => {
    const svc = makeService();
    // Generamos un JWT válido pero NO registramos su pública.
    const { token } = await signWith(baseManifest, { kid: 'kid-no-registrado' });
    await expect(svc.verifyManifestJwt(token)).rejects.toMatchObject({
      code: 'SIGNATURE_VERIFY_FAILED',
    });
  });

  it('SIGNATURE_VERIFY_FAILED si la firma es de otra clave', async () => {
    const svc = makeService();
    // Registramos la clave pública del keypair A...
    const trusted = await generateTestKeypair();
    svc.registerPublicKeyForTest('didacta-test-key', trusted.publicKey);
    // ... pero firmamos con keypair B. El kid coincide pero la firma no.
    const { token } = await signWith(baseManifest, { kid: 'didacta-test-key' });
    await expect(svc.verifyManifestJwt(token)).rejects.toMatchObject({
      code: 'SIGNATURE_VERIFY_FAILED',
    });
  });

  it('SIGNATURE_VERIFY_FAILED si el issuer no coincide', async () => {
    const svc = makeService();
    const { privateKey, publicKey } = await generateTestKeypair();
    svc.registerPublicKeyForTest('didacta-test-key', publicKey);
    const { token } = await signWith(baseManifest, {
      privateKey,
      kid: 'didacta-test-key',
      issuer: 'evil.example.com',
    });
    await expect(svc.verifyManifestJwt(token)).rejects.toMatchObject({
      code: 'SIGNATURE_VERIFY_FAILED',
    });
  });

  it('SIGNATURE_VERIFY_FAILED si el audience no coincide', async () => {
    const svc = makeService();
    const { privateKey, publicKey } = await generateTestKeypair();
    svc.registerPublicKeyForTest('didacta-test-key', publicKey);
    const { token } = await signWith(baseManifest, {
      privateKey,
      kid: 'didacta-test-key',
      audience: 'didacta-runtime', // este es el audience del license-sdk, no marketplace
    });
    await expect(svc.verifyManifestJwt(token)).rejects.toMatchObject({
      code: 'SIGNATURE_VERIFY_FAILED',
    });
  });

  it('MANIFEST_SCHEMA_INVALID si el payload no cumple el schema', async () => {
    const svc = makeService();
    const { privateKey, publicKey } = await generateTestKeypair();
    svc.registerPublicKeyForTest('didacta-test-key', publicKey);
    const { token } = await signWith(
      { ...baseManifest, name: 'invalid-name' as `mod.${string}` },
      { privateKey, kid: 'didacta-test-key' },
    );
    await expect(svc.verifyManifestJwt(token)).rejects.toMatchObject({
      code: 'MANIFEST_SCHEMA_INVALID',
    });
  });

  it('VENDOR_NOT_TRUSTED si el manifest declara vendor=community', async () => {
    const svc = makeService();
    const { privateKey, publicKey } = await generateTestKeypair();
    svc.registerPublicKeyForTest('didacta-test-key', publicKey);
    const { token } = await signWith(
      { ...baseManifest, vendor: 'community' as const },
      { privateKey, kid: 'didacta-test-key' },
    );
    await expect(svc.verifyManifestJwt(token)).rejects.toMatchObject({
      code: 'VENDOR_NOT_TRUSTED',
    });
  });

  it('SIGNATURE_VERIFY_FAILED si el header del JWT no trae kid', async () => {
    const svc = makeService();
    const { privateKey } = await generateTestKeypair();
    // Construimos un JWT sin kid.
    const token = await new SignJWT(baseManifest as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setIssuer(MARKETPLACE_ISSUER)
      .setAudience(MARKETPLACE_AUDIENCE)
      .sign(privateKey);
    await expect(svc.verifyManifestJwt(token)).rejects.toMatchObject({
      code: 'SIGNATURE_VERIFY_FAILED',
    });
  });
});
