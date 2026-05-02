import AdmZip from 'adm-zip';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import type { ModuleManifest } from '../../../src/marketplace/module-manifest.schema';
import {
  MARKETPLACE_AUDIENCE,
  MARKETPLACE_ISSUER,
  ModuleSignatureService,
} from '../../../src/marketplace/module-signature.service';

/// Fixture builder: genera un par ES256 efímero, construye un manifest
/// válido, lo firma como JWT y arma un buffer `*.zip` listo para
/// alimentar a `ModulePackageService.validatePackage`.
///
/// Mismo patrón que `packages/license-sdk/tests/setup-test-keys.ts` —
/// las claves privadas viven solo en memoria del proceso de test, y la
/// pública se registra en el verifier vía `registerPublicKeyForTest()`.
/// No tocamos AWS KMS en tests.

const TEST_KID = 'didacta-test-marketplace';

export const baseManifest: ModuleManifest = {
  name: 'mod.example',
  version: '1.0.0',
  displayName: 'Example Module',
  description: 'Módulo de ejemplo usado en tests del pipeline marketplace.',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_example_',
  apiNamespace: '/modules/example',
  vendor: 'didacta',
  signedAt: '2026-05-02T00:00:00.000Z',
  permissions: [],
  eventsEmitted: [],
  eventsConsumed: [],
  hooksProvided: [],
  hooksConsumed: [],
  requiredCapabilities: [],
  requiredEnvVars: [],
  isolation: 'vm',
};

export interface BuildOptions {
  manifest?: Partial<ModuleManifest>;
  /// Override del par ES256 a usar para firmar. Por default cada llamada
  /// genera uno fresh. Útil cuando un test necesita firmar varios
  /// paquetes con la misma clave (escenario "vendor consistente").
  keypair?: { privateKey: KeyLike; publicKey: KeyLike };
  /// Override de archivos. Pasar `null` para omitir el archivo del ZIP.
  /// Útil para probar `PACKAGE_MISSING_FILE`.
  files?: Partial<
    Record<'manifest.jwt' | 'package.json' | 'dist/index.js', string | Buffer | null>
  >;
  /// Override del JWT a meter en `manifest.jwt`. Si se pasa, ignora el
  /// manifest derivado. Útil para probar SIGNATURE_VERIFY_FAILED.
  manifestJwtOverride?: string;
  /// Override del kid del JWT — útil para probar `Unknown kid`.
  kid?: string;
  /// Override del audience del JWT — útil para probar audience inválido.
  audience?: string;
  /// Override del issuer del JWT.
  issuer?: string;
  /// Servicio donde registrar la pública. Si se omite, NO se registra y
  /// el test puede preparar su propio escenario (kid desconocido).
  signatureService?: ModuleSignatureService;
}

export interface BuildResult {
  buffer: Buffer;
  privateKey: KeyLike;
  publicKey: KeyLike;
  manifest: ModuleManifest;
  manifestJwt: string;
  kid: string;
}

export async function generateTestKeypair(): Promise<{
  privateKey: KeyLike;
  publicKey: KeyLike;
}> {
  return generateKeyPair('ES256');
}

export async function buildTestPackage(options: BuildOptions = {}): Promise<BuildResult> {
  const { privateKey, publicKey } = options.keypair ?? (await generateKeyPair('ES256'));
  const manifest: ModuleManifest = { ...baseManifest, ...options.manifest };
  const kid = options.kid ?? TEST_KID;

  const manifestJwt =
    options.manifestJwtOverride ??
    (await new SignJWT(manifest as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setIssuer(options.issuer ?? MARKETPLACE_ISSUER)
      .setAudience(options.audience ?? MARKETPLACE_AUDIENCE)
      .setIssuedAt()
      .sign(privateKey));

  if (options.signatureService) {
    options.signatureService.registerPublicKeyForTest(kid, publicKey);
  }

  const defaultFiles: Record<string, string | Buffer> = {
    'manifest.jwt': manifestJwt,
    'package.json': JSON.stringify(
      { name: manifest.name, version: manifest.version, main: 'dist/index.js' },
      null,
      2,
    ),
    'dist/index.js': '"use strict"; module.exports = { onInstall: () => {} };\n',
  };

  const zip = new AdmZip();
  const overrides = options.files ?? {};
  for (const [name, defaultContent] of Object.entries(defaultFiles)) {
    if (name in overrides) {
      const override = overrides[name as keyof typeof overrides];
      if (override === null) continue;
      const buf = typeof override === 'string' ? Buffer.from(override, 'utf8') : override!;
      zip.addFile(name, buf);
    } else {
      const buf =
        typeof defaultContent === 'string' ? Buffer.from(defaultContent, 'utf8') : defaultContent;
      zip.addFile(name, buf);
    }
  }
  for (const [name, content] of Object.entries(overrides)) {
    if (defaultFiles[name] !== undefined) continue;
    if (content === null) continue;
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : (content as Buffer);
    zip.addFile(name, buf);
  }

  return {
    buffer: zip.toBuffer(),
    privateKey,
    publicKey,
    manifest,
    manifestJwt,
    kid,
  };
}
