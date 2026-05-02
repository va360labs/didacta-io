import AdmZip from 'adm-zip';
import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
  type KeyPairKeyObjectResult,
} from 'node:crypto';
import { canonicalManifestBytes, type ModuleManifest } from '../../../src/marketplace/module-manifest.schema';

/// Fixture builder: genera un par RSA, construye un manifest válido,
/// firma el manifest y arma un buffer `*.didactamod` listo para alimentar a
/// `ModulePackageService.validatePackage`. Usado por los tests unitarios.
///
/// El builder vive en tests (no en src) porque genera claves nuevas cada
/// llamada y NO debe usarse en producción. La clave pública se devuelve en
/// PEM para que el test la inyecte por env var antes de instanciar
/// `ModuleSignatureService`.

export const baseManifest: ModuleManifest = {
  name: 'mod.example',
  version: '1.0.0',
  displayName: 'Example Module',
  description: 'Módulo de ejemplo usado en tests del pipeline marketplace.',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_example_',
  apiNamespace: '/modules/example',
  vendor: 'va360',
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
  keypair?: KeyPairKeyObjectResult;
  /// Override de archivos. Pasar `null` para omitir el archivo del ZIP.
  /// Útil para probar `PACKAGE_MISSING_FILE`.
  files?: Partial<Record<'manifest.json' | 'manifest.sig' | 'package.json' | 'dist/index.js', string | Buffer | null>>;
  /// Si true, NO firma — devuelve un signature aleatorio (usado para
  /// probar SIGNATURE_VERIFY_FAILED).
  tamperSignature?: boolean;
}

export interface BuildResult {
  buffer: Buffer;
  publicKeyPem: string;
  privateKey: KeyObject;
  manifest: ModuleManifest;
}

export function generateTestKeypair(): KeyPairKeyObjectResult {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

export function buildTestPackage(options: BuildOptions = {}): BuildResult {
  const keypair = options.keypair ?? generateTestKeypair();
  const manifest: ModuleManifest = { ...baseManifest, ...options.manifest };

  const canonical = canonicalManifestBytes(manifest);
  let signatureB64: string;
  if (options.tamperSignature) {
    signatureB64 = Buffer.alloc(256, 0xff).toString('base64');
  } else {
    const signer = createSign('sha256');
    signer.update(canonical);
    signer.end();
    const signature = signer.sign({ key: keypair.privateKey, padding: 6, saltLength: 32 });
    signatureB64 = signature.toString('base64');
  }

  const defaultFiles: Record<string, string | Buffer> = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'manifest.sig': signatureB64,
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

  const publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  return {
    buffer: zip.toBuffer(),
    publicKeyPem,
    privateKey: keypair.privateKey,
    manifest,
  };
}
