import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketplacePackageError } from '../../src/marketplace/module-package.errors';
import {
  isCoreVersionCompatible,
  ModulePackageService,
  RESERVED_MODULE_NAMES,
} from '../../src/marketplace/module-package.service';
import { ModuleSignatureService } from '../../src/marketplace/module-signature.service';
import { buildTestPackage, generateTestKeypair } from './fixtures/build-test-package';

const ENV_VA360 = 'MARKETPLACE_TRUSTED_VENDOR_KEYS_VA360';

function makeService(publicKeyPem: string): ModulePackageService {
  process.env[ENV_VA360] = publicKeyPem;
  const sig = new ModuleSignatureService();
  sig.onModuleInit();
  return new ModulePackageService(sig);
}

describe('ModulePackageService.validatePackage', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV_VA360];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VA360];
    else process.env[ENV_VA360] = original;
  });

  it('acepta un paquete bien formado y firmado por VA360', async () => {
    const fixture = buildTestPackage();
    const svc = makeService(fixture.publicKeyPem);
    const result = await svc.validatePackage(fixture.buffer, { coreVersion: '1.2.0' });
    expect(result.manifest.name).toBe('mod.example');
    expect(result.signatureB64.length).toBeGreaterThan(0);
    expect(result.packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.packageSizeBytes).toBe(fixture.buffer.length);
    expect(result.canonicalManifest.length).toBeGreaterThan(0);
  });

  it('PACKAGE_INVALID_ZIP con buffer vacío', async () => {
    const fixture = buildTestPackage();
    const svc = makeService(fixture.publicKeyPem);
    await expect(svc.validatePackage(Buffer.alloc(0), { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'PACKAGE_INVALID_ZIP' },
    );
  });

  it('PACKAGE_INVALID_ZIP con bytes que no son ZIP', async () => {
    const fixture = buildTestPackage();
    const svc = makeService(fixture.publicKeyPem);
    await expect(
      svc.validatePackage(Buffer.from('no soy un zip'), { coreVersion: '1.0.0' }),
    ).rejects.toBeInstanceOf(MarketplacePackageError);
  });

  it('PACKAGE_TOO_LARGE si excede 50 MB', async () => {
    const fixture = buildTestPackage();
    const svc = makeService(fixture.publicKeyPem);
    const big = Buffer.alloc(51 * 1024 * 1024);
    await expect(svc.validatePackage(big, { coreVersion: '1.0.0' })).rejects.toMatchObject({
      code: 'PACKAGE_TOO_LARGE',
    });
  });

  it.each(['manifest.json', 'manifest.sig', 'package.json', 'dist/index.js'] as const)(
    'PACKAGE_MISSING_FILE si falta %s',
    async (missing) => {
      const fixture = buildTestPackage({ files: { [missing]: null } });
      const svc = makeService(fixture.publicKeyPem);
      await expect(
        svc.validatePackage(fixture.buffer, { coreVersion: '1.0.0' }),
      ).rejects.toMatchObject({ code: 'PACKAGE_MISSING_FILE', details: { missingFile: missing } });
    },
  );

  it('MANIFEST_INVALID_JSON si manifest.json no parsea', async () => {
    const fixture = buildTestPackage({ files: { 'manifest.json': '{ no soy json' } });
    const svc = makeService(fixture.publicKeyPem);
    await expect(svc.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'MANIFEST_INVALID_JSON' },
    );
  });

  it('MANIFEST_SCHEMA_INVALID si name no cumple el regex', async () => {
    const fixture = buildTestPackage({ manifest: { name: 'invalid' as `mod.${string}` } });
    const svc = makeService(fixture.publicKeyPem);
    await expect(svc.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'MANIFEST_SCHEMA_INVALID' },
    );
  });

  it('MANIFEST_CONSISTENCY_INVALID si tablePrefix no deriva del name', async () => {
    const fixture = buildTestPackage({
      manifest: { name: 'mod.alpha', tablePrefix: 'mod_beta_', apiNamespace: '/modules/alpha' },
    });
    const svc = makeService(fixture.publicKeyPem);
    await expect(svc.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'MANIFEST_CONSISTENCY_INVALID' },
    );
  });

  it('SIGNATURE_VERIFY_FAILED si la firma no corresponde al manifest', async () => {
    const fixture = buildTestPackage({ tamperSignature: true });
    const svc = makeService(fixture.publicKeyPem);
    await expect(svc.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'SIGNATURE_VERIFY_FAILED' },
    );
  });

  it('VENDOR_NOT_TRUSTED si la instancia no tiene la clave del vendor', async () => {
    const fixture = buildTestPackage();
    delete process.env[ENV_VA360];
    const sig = new ModuleSignatureService();
    sig.onModuleInit();
    const svc = new ModulePackageService(sig);
    await expect(svc.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'VENDOR_NOT_TRUSTED' },
    );
  });

  it('VENDOR_NOT_TRUSTED si el manifest declara vendor=community (no soportado MVP)', async () => {
    const fixture = buildTestPackage({ manifest: { vendor: 'community' } });
    const svc = makeService(fixture.publicKeyPem);
    await expect(svc.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'VENDOR_NOT_TRUSTED' },
    );
  });

  it('CORE_VERSION_INCOMPATIBLE si el core actual no satisface coreVersionRequired', async () => {
    const fixture = buildTestPackage({ manifest: { coreVersionRequired: '^2.0.0' } });
    const svc = makeService(fixture.publicKeyPem);
    await expect(svc.validatePackage(fixture.buffer, { coreVersion: '1.5.0' })).rejects.toMatchObject(
      { code: 'CORE_VERSION_INCOMPATIBLE' },
    );
  });

  it('NAME_RESERVED si el nombre coincide con un built-in', async () => {
    const reserved = Array.from(RESERVED_MODULE_NAMES)[0];
    const slug = reserved.replace(/^mod\./, '');
    const fixture = buildTestPackage({
      manifest: {
        name: reserved as `mod.${string}`,
        tablePrefix: `mod_${slug.replace(/-/g, '_')}_`,
        apiNamespace: `/modules/${slug}`,
      },
    });
    const svc = makeService(fixture.publicKeyPem);
    await expect(svc.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'NAME_RESERVED' },
    );
  });

  it('reusa la misma clave para múltiples paquetes (fixture compartible)', async () => {
    const keypair = generateTestKeypair();
    const a = buildTestPackage({ keypair, manifest: { name: 'mod.alpha', tablePrefix: 'mod_alpha_', apiNamespace: '/modules/alpha' } });
    const b = buildTestPackage({ keypair, manifest: { name: 'mod.beta', tablePrefix: 'mod_beta_', apiNamespace: '/modules/beta' } });
    const svc = makeService(a.publicKeyPem);
    await expect(svc.validatePackage(a.buffer, { coreVersion: '1.0.0' })).resolves.toBeDefined();
    await expect(svc.validatePackage(b.buffer, { coreVersion: '1.0.0' })).resolves.toBeDefined();
  });
});

describe('isCoreVersionCompatible', () => {
  it('exact: solo si coincide literalmente', () => {
    expect(isCoreVersionCompatible('1.2.3', '1.2.3')).toBe(true);
    expect(isCoreVersionCompatible('1.2.3', '1.2.4')).toBe(false);
  });

  it('caret: mismo major, minor.patch ≥ requerido', () => {
    expect(isCoreVersionCompatible('^1.2.3', '1.2.3')).toBe(true);
    expect(isCoreVersionCompatible('^1.2.3', '1.2.4')).toBe(true);
    expect(isCoreVersionCompatible('^1.2.3', '1.3.0')).toBe(true);
    expect(isCoreVersionCompatible('^1.2.3', '1.2.2')).toBe(false);
    expect(isCoreVersionCompatible('^1.2.3', '2.0.0')).toBe(false);
  });

  it('tilde: mismo major.minor, patch ≥ requerido', () => {
    expect(isCoreVersionCompatible('~1.2.3', '1.2.3')).toBe(true);
    expect(isCoreVersionCompatible('~1.2.3', '1.2.4')).toBe(true);
    expect(isCoreVersionCompatible('~1.2.3', '1.3.0')).toBe(false);
    expect(isCoreVersionCompatible('~1.2.3', '1.2.2')).toBe(false);
  });

  it('rangos no soportados se tratan como incompatibles', () => {
    expect(isCoreVersionCompatible('>=1.0.0', '1.5.0')).toBe(false);
  });
});
