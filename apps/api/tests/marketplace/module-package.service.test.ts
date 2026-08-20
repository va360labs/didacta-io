import { describe, expect, it } from 'vitest';
import semver from 'semver';
import { resolveCoreContractVersion } from '../../src/core-version';

/**
 * El rango que declaran los 24 módulos first-party en su `module.json` y su
 * `src/manifest.ts`. Si esto cambia, cambia en los 48 sitios a la vez y
 * `module-doctor` lo caza.
 */
const RANGO_FIRST_PARTY = '^0.1.0';
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
    await expect(
      pkg.validatePackage(Buffer.alloc(0), { coreVersion: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'PACKAGE_INVALID_ZIP' });
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
    await expect(
      pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('firma manipulada → NO bloquea (DISC-002): source DIRECT_UPLOAD y manifestJwt null', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({ signatureService: sig });
    // Cortamos la última parte (signature) y la sustituimos por un valor inválido.
    const parts = fixture.manifestJwt.split('.');
    const tampered = `${parts[0]}.${parts[1]}.AAAA${parts[2]?.slice(4)}`;
    const tamperedFixture = await buildTestPackage({
      signatureService: sig,
      manifestJwtOverride: tampered,
    });
    // DISC-002: la verificación de firma ya NO bloquea; un JWT manipulado se
    // trata como subida directa (no de confianza) en lugar de rechazarse.
    const result = await pkg.validatePackage(tamperedFixture.buffer, { coreVersion: '1.0.0' });
    expect(result.signatureVerified).toBe(false);
    expect(result.manifestJwt).toBeNull();
    expect(result.source).toBe('DIRECT_UPLOAD');
  });

  it('MANIFEST_SCHEMA_INVALID si el JWT lleva un manifest con name inválido', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { name: 'invalid' as `mod.${string}` },
    });
    await expect(
      pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'MANIFEST_SCHEMA_INVALID' });
  });

  it('MANIFEST_CONSISTENCY_INVALID si tablePrefix no deriva del name', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { name: 'mod.alpha', tablePrefix: 'mod_beta_', apiNamespace: '/modules/alpha' },
    });
    await expect(
      pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'MANIFEST_CONSISTENCY_INVALID' });
  });

  it('vendor=community → NO se rechaza (DISC-002): se acepta como DIRECT_UPLOAD no confiable', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { vendor: 'community' as const },
    });
    // DISC-002: el gate de vendor-trust dejó de bloquear. verifyManifestJwt aún
    // marca VENDOR_NOT_TRUSTED internamente, pero tryVerifyManifestJwt lo degrada
    // a no-verificado → el paquete valida como DIRECT_UPLOAD (no de confianza)
    // en lugar de lanzar. La confianza se expresa por `source`, no rechazando.
    const result = await pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' });
    expect(result.signatureVerified).toBe(false);
    expect(result.source).toBe('DIRECT_UPLOAD');
    expect(result.manifestJwt).toBeNull();
    expect(result.manifest.vendor).toBe('community');
  });

  it('CORE_VERSION_INCOMPATIBLE si el core actual no satisface coreVersionRequired', async () => {
    const { pkg, sig } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { coreVersionRequired: '^2.0.0' },
    });
    await expect(
      pkg.validatePackage(fixture.buffer, { coreVersion: '1.5.0' }),
    ).rejects.toMatchObject({ code: 'CORE_VERSION_INCOMPATIBLE' });
  });

  it('NAME_RESERVED si el nombre coincide con un built-in', async () => {
    const { pkg, sig } = makeServices();
    const reserved = Array.from(RESERVED_MODULE_NAMES)[0];
    const slug = reserved!.replace(/^mod\./, '');
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: {
        name: reserved as `mod.${string}`,
        tablePrefix: `mod_${slug.replace(/-/g, '_')}_`,
        apiNamespace: `/modules/${slug}`,
      },
    });
    await expect(
      pkg.validatePackage(fixture.buffer, { coreVersion: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'NAME_RESERVED' });
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
  describe('pre-release support', () => {
    it('caret con pre-release: ^0.0.1-alpha.0 matchea 0.0.1-alpha.41', () => {
      expect(isCoreVersionCompatible('^0.0.1-alpha.0', '0.0.1-alpha.41')).toBe(true);
    });

    it('caret con pre-release: ^0.0.1-alpha.0 matchea 0.0.1-alpha.0', () => {
      expect(isCoreVersionCompatible('^0.0.1-alpha.0', '0.0.1-alpha.0')).toBe(true);
    });

    it('caret con pre-release: ^0.0.1-alpha.50 NO matchea 0.0.1-alpha.41', () => {
      expect(isCoreVersionCompatible('^0.0.1-alpha.50', '0.0.1-alpha.41')).toBe(false);
    });

    it('caret sin pre-release matchea version con pre-release', () => {
      expect(isCoreVersionCompatible('^0.0.1', '0.0.1-alpha.41')).toBe(true);
    });

    it('caret en 0.0.x NO abre el rango hacia arriba (M15)', () => {
      // npm trata `^0.0.1` como "exactamente 0.0.1": en 0.0.x cada patch puede
      // romper. Este test decía lo contrario, y esa lectura era fail-open: un
      // módulo empaquetado contra `^0.0.1` se instalaba en un core 0.9.0 pese a
      // que entre esos dos minors el contrato pudo cambiar entero. Y el core
      // lleva toda su vida en 0.x, así que este es el caso normal.
      expect(isCoreVersionCompatible('^0.0.1-alpha.0', '0.0.2')).toBe(false);
      expect(isCoreVersionCompatible('^0.0.1', '0.9.0')).toBe(false);
      expect(isCoreVersionCompatible('^0.0.1', '0.1.0')).toBe(false);
    });

    it('caret en 0.x.y admite patches pero no el salto de minor', () => {
      // `^0.1.2` = >=0.1.2 <0.2.0. En 0.x el minor hace de major.
      expect(isCoreVersionCompatible('^0.1.2', '0.1.2')).toBe(true);
      expect(isCoreVersionCompatible('^0.1.2', '0.1.9')).toBe(true);
      expect(isCoreVersionCompatible('^0.1.2', '0.2.0')).toBe(false);
      expect(isCoreVersionCompatible('^0.1.2', '0.1.1')).toBe(false);
    });

    it('en 1.x el caret sigue abriendo minor y patch, como siempre', () => {
      expect(isCoreVersionCompatible('^1.2.0', '1.5.0')).toBe(true);
      expect(isCoreVersionCompatible('^1.2.0', '1.2.9')).toBe(true);
      expect(isCoreVersionCompatible('^1.2.0', '2.0.0')).toBe(false);
      expect(isCoreVersionCompatible('^1.2.0', '1.1.9')).toBe(false);
    });

    it('el arranque y el instalador validan contra LA MISMA versión', () => {
      // Antes había dos fuentes de verdad para el mismo campo: el arranque
      // comparaba contra un `CORE_VERSION = '0.0.1'` escrito a mano, y el
      // instalador contra `DIDACTA_CORE_VERSION`, el tag de la imagen. Un
      // módulo que declaraba `^0.0.1` pasaba una y fallaba la otra; sólo lo
      // tapaba que el comparador fuese permisivo. Ahora las dos salen de
      // `resolveCoreContractVersion()`.
      //
      // La versión se LEE, no se escribe: un literal aquí se fosilizaría en el
      // siguiente corte de release (ya pasó una vez, cortando la beta.6).
      const contrato = resolveCoreContractVersion();

      // Camino del instalador (comparador propio de este fichero).
      expect(isCoreVersionCompatible(RANGO_FIRST_PARTY, contrato)).toBe(true);
      // Camino del arranque (semver de verdad, en core-registry).
      expect(semver.satisfies(contrato, RANGO_FIRST_PARTY)).toBe(true);
    });

    it('la versión de contrato no arrastra el prerelease', () => {
      // Es la razón de que exista `resolveCoreContractVersion` y no se use la
      // versión a pelo: semver ordena TODO prerelease por debajo de su versión
      // final, así que `0.1.0-beta.6` no satisface `^0.1.0` y durante la beta
      // entera no cargaría ni un módulo. Medido, no supuesto.
      expect(semver.satisfies('0.1.0-beta.6', '^0.1.0')).toBe(false);
      expect(resolveCoreContractVersion()).not.toContain('-');
    });

    it('tilde con pre-release: ~0.0.1-alpha.0 matchea 0.0.1-alpha.41', () => {
      expect(isCoreVersionCompatible('~0.0.1-alpha.0', '0.0.1-alpha.41')).toBe(true);
    });

    it('tilde con pre-release: ~0.0.1-alpha.0 NO matchea 0.0.2', () => {
      expect(isCoreVersionCompatible('~0.0.1-alpha.0', '0.0.2')).toBe(false);
    });

    it('exact con pre-release: solo si coincide literalmente', () => {
      expect(isCoreVersionCompatible('0.0.1-alpha.41', '0.0.1-alpha.41')).toBe(true);
      expect(isCoreVersionCompatible('0.0.1-alpha.40', '0.0.1-alpha.41')).toBe(false);
    });

    it('pre-release beta > alpha alfabeticamente', () => {
      expect(isCoreVersionCompatible('^0.0.1-alpha.0', '0.0.1-beta.0')).toBe(true);
    });
  });
});
