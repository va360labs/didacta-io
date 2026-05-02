import { describe, expect, it } from 'vitest';
import { MarketplacePackageError } from '../../src/marketplace/module-package.errors';
import {
  isCoreVersionCompatible,
  ModulePackageService,
  RESERVED_MODULE_NAMES,
} from '../../src/marketplace/module-package.service';
import { ModuleSignatureService } from '../../src/marketplace/module-signature.service';
import { buildTestPackage, generateTestKeypair } from './fixtures/build-test-package';

function makeServices(): {
  pkg: ModulePackageService;
  sig: ModuleSignatureService;
} {
  const sig = new ModuleSignatureService();
  sig.onModuleInit();
  return { pkg: new ModulePackageService(sig), sig };
}

describe('ModulePackageService.validatePackage', () => {
  it('acepta un paquete bien formado y firmado por Didacta', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({ signatureService: sig });
    const result = await pkg.validatePackage(fixture.buffer, { coreVersion: '1.2.0' });
    expect(result.manifest.name).toBe('mod.example');
    expect(result.manifestJwt).toBe(fixture.manifestJwt);
    expect(result.packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.packageSizeBytes).toBe(fixture.buffer.length);
  });

  it('PACKAGE_INVALID_ZIP con buffer vacío', async () => {
    const { pkg } = makeServices();
    await expect(pkg.validatePackage(Buffer.alloc(0), { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'PACKAGE_INVALID_ZIP' },
    );
  });

  it('PACKAGE_INVALID_ZIP con bytes que no son ZIP', async () => {
    const { pkg } = makeServices();
    await expect(
      pkg.validatePackage(Buffer.from('no soy un zip'), { coreVersion: '1.0.0' }),
    ).rejects.toBeInstanceOf(MarketplacePackageError);
  });

  it('PACKAGE_TOO_LARGE si excede 50 MB', async () => {
    const { pkg } = makeServices();
    const big = Buffer.alloc(51 * 1024 * 1024);
    await expect(pkg.validatePackage(big, { coreVersion: '1.0.0' })).rejects.toMatchObject({
      code: 'PACKAGE_TOO_LARGE',
    });
  });

  it.each(['manifest.jwt', 'package.json', 'dist/index.js'] as const)(
    'PACKAGE_MISSING_FILE si falta %s',
    async (missing) => {
      const { pkg, sig } = makeServices();
      const fixture = await buildTestPackage({
        signatureService: sig,
        files: { [missing]: null },
      });
      await expect(
        pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' }),
      ).rejects.toMatchObject({ code: 'PACKAGE_MISSING_FILE', details: { missingFile: missing } });
    },
  );

  it('SIGNATURE_INVALID si manifest.jwt no es un JWT', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifestJwtOverride: 'no-soy-un-jwt',
    });
    await expect(pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'SIGNATURE_INVALID' },
    );
  });

  it('SIGNATURE_VERIFY_FAILED si la firma del JWT está manipulada', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({ signatureService: sig });
    // Cortamos la última parte (signature) y la sustituimos por un valor inválido.
    const parts = fixture.manifestJwt.split('.');
    const tampered = `${parts[0]}.${parts[1]}.AAAA${parts[2]?.slice(4)}`;
    const tamperedFixture = await buildTestPackage({
      signatureService: sig,
      manifestJwtOverride: tampered,
    });
    await expect(
      pkg.validatePackage(tamperedFixture.buffer, { coreVersion: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_VERIFY_FAILED' });
  });

  it('MANIFEST_SCHEMA_INVALID si el JWT lleva un manifest con name inválido', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { name: 'invalid' as `mod.${string}` },
    });
    await expect(pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'MANIFEST_SCHEMA_INVALID' },
    );
  });

  it('MANIFEST_CONSISTENCY_INVALID si tablePrefix no deriva del name', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { name: 'mod.alpha', tablePrefix: 'mod_beta_', apiNamespace: '/modules/alpha' },
    });
    await expect(pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'MANIFEST_CONSISTENCY_INVALID' },
    );
  });

  it('VENDOR_NOT_TRUSTED si vendor=community (no soportado MVP)', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { vendor: 'community' as const },
    });
    await expect(pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'VENDOR_NOT_TRUSTED' },
    );
  });

  it('CORE_VERSION_INCOMPATIBLE si el core actual no satisface coreVersionRequired', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { coreVersionRequired: '^2.0.0' },
    });
    await expect(pkg.validatePackage(fixture.buffer, { coreVersion: '1.5.0' })).rejects.toMatchObject(
      { code: 'CORE_VERSION_INCOMPATIBLE' },
    );
  });

  it('NAME_RESERVED si el nombre coincide con un built-in', async () => {
    const { pkg, sig } = makeServices();
    const reserved = Array.from(RESERVED_MODULE_NAMES)[0];
    const slug = reserved.replace(/^mod\./, '');
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: {
        name: reserved as `mod.${string}`,
        tablePrefix: `mod_${slug.replace(/-/g, '_')}_`,
        apiNamespace: `/modules/${slug}`,
      },
    });
    await expect(pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' })).rejects.toMatchObject(
      { code: 'NAME_RESERVED' },
    );
  });

  it('reusa la misma clave para múltiples paquetes (fixture compartible)', async () => {
    const { pkg, sig } = makeServices();
    const keypair = await generateTestKeypair();
    const a = await buildTestPackage({
      signatureService: sig,
      keypair,
      manifest: {
        name: 'mod.alpha',
        tablePrefix: 'mod_alpha_',
        apiNamespace: '/modules/alpha',
      },
    });
    const b = await buildTestPackage({
      signatureService: sig,
      keypair,
      manifest: { name: 'mod.beta', tablePrefix: 'mod_beta_', apiNamespace: '/modules/beta' },
    });
    await expect(pkg.validatePackage(a.buffer, { coreVersion: '1.0.0' })).resolves.toBeDefined();
    await expect(pkg.validatePackage(b.buffer, { coreVersion: '1.0.0' })).resolves.toBeDefined();
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
