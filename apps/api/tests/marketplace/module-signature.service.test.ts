import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalManifestBytes } from '../../src/marketplace/module-manifest.schema';
import { MarketplacePackageError } from '../../src/marketplace/module-package.errors';
import { ModuleSignatureService } from '../../src/marketplace/module-signature.service';
import { baseManifest, buildTestPackage, generateTestKeypair } from './fixtures/build-test-package';

const ENV_VA360 = 'MARKETPLACE_TRUSTED_VENDOR_KEYS_VA360';

describe('ModuleSignatureService', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_VA360];
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_VA360];
    else process.env[ENV_VA360] = originalEnv;
  });

  it('isVendorTrusted=false sin clave configurada', () => {
    delete process.env[ENV_VA360];
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    expect(svc.isVendorTrusted('va360')).toBe(false);
  });

  it('isVendorTrusted=true con clave RSA 2048', () => {
    const { publicKeyPem } = buildTestPackage();
    process.env[ENV_VA360] = publicKeyPem;
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    expect(svc.isVendorTrusted('va360')).toBe(true);
  });

  it('rechaza clave RSA inferior a 2048 bits', () => {
    const { publicKey } = require('node:crypto').generateKeyPairSync('rsa', {
      modulusLength: 1024,
    }) as ReturnType<typeof generateTestKeypair>;
    process.env[ENV_VA360] = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    expect(svc.isVendorTrusted('va360')).toBe(false);
  });

  it('verifyManifestSignature acepta firma RSA-PSS-SHA256 generada con la clave del vendor', () => {
    const fixture = buildTestPackage();
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    const canonical = canonicalManifestBytes(fixture.manifest);
    expect(() =>
      svc.verifyManifestSignature('va360', canonical, signWithFixture(canonical, fixture)),
    ).not.toThrow();
  });

  it('rechaza firma de un manifest distinto (tampered manifest)', () => {
    const fixture = buildTestPackage();
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    const canonical = canonicalManifestBytes(fixture.manifest);
    const validSig = signWithFixture(canonical, fixture);
    const tampered = canonicalManifestBytes({ ...baseManifest, version: '9.9.9' });
    expect(() => svc.verifyManifestSignature('va360', tampered, validSig)).toThrowError(
      MarketplacePackageError,
    );
  });

  it('rechaza firma generada con otra clave RSA', () => {
    const trusted = buildTestPackage();
    process.env[ENV_VA360] = trusted.publicKeyPem;
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    const intruder = buildTestPackage(); // genera otro keypair
    const canonical = canonicalManifestBytes(trusted.manifest);
    const intruderSig = signWithFixture(canonical, intruder);
    expect(() => svc.verifyManifestSignature('va360', canonical, intruderSig)).toThrowError(
      /SIGNATURE_VERIFY_FAILED/,
    );
  });

  it('VENDOR_NOT_TRUSTED si vendor no está configurado', () => {
    delete process.env[ENV_VA360];
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    expect(() =>
      svc.verifyManifestSignature('va360', Buffer.from('x'), Buffer.alloc(256).toString('base64')),
    ).toThrowError(/VENDOR_NOT_TRUSTED/);
  });

  it('VENDOR_NOT_TRUSTED si vendor es desconocido (community no soportado en MVP)', () => {
    const fixture = buildTestPackage();
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    expect(() =>
      svc.verifyManifestSignature('community', Buffer.from('x'), 'AAAA'),
    ).toThrowError(/VENDOR_NOT_TRUSTED/);
  });

  it('SIGNATURE_INVALID con base64 vacío', () => {
    const fixture = buildTestPackage();
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const svc = new ModuleSignatureService();
    svc.onModuleInit();
    expect(() =>
      svc.verifyManifestSignature('va360', canonicalManifestBytes(fixture.manifest), ''),
    ).toThrowError(/SIGNATURE_INVALID/);
  });
});

function signWithFixture(
  canonical: Buffer,
  fixture: ReturnType<typeof buildTestPackage>,
): string {
  const { createSign } = require('node:crypto') as typeof import('node:crypto');
  const signer = createSign('sha256');
  signer.update(canonical);
  signer.end();
  return signer.sign({ key: fixture.privateKey, padding: 6, saltLength: 32 }).toString('base64');
}
