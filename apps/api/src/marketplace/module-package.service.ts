import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import {
  validateManifestConsistency,
  validateSurfaceBundles,
  type ModuleManifest,
} from './module-manifest.schema';
import { MarketplacePackageError } from './module-package.errors';
import { ModuleSignatureService } from './module-signature.service';

/// Tamaño máximo del paquete (bytes). 50 MB es coherente con ADR-009 §3.1
/// (validación de tamaño antes de extraer). Por encima rechazamos para
/// evitar zip bombs y abuso de disco.
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

/// Nombres de fichero requeridos dentro del ZIP. La ausencia de cualquiera
/// implica `PACKAGE_MISSING_FILE`. La presencia se valida case-sensitive
/// (POSIX) — un ZIP creado en Windows con casing distinto se rechaza para
/// evitar comportamiento divergente entre instancias linux/mac.
///
/// `manifest.jwt` reemplaza el par `manifest.json` + `manifest.sig` del
/// diseño inicial: el JWT lleva manifest+firma en una sola línea ES256.
export const REQUIRED_FILES = [
  'manifest.jwt',
  'package.json',
  'dist/index.js',
] as const;

/// Slugs reservados que ningún módulo de marketplace puede registrar:
/// son built-ins de la imagen `didactaio/community` o nombres infra que
/// chocarían con el core. Lista en sync con `tenant-modules.service.ts`
/// y `module-registry.service.ts` (ver auditoría manual al añadir un
/// built-in nuevo). Si la lista crece, considerar mover a config.
export const RESERVED_MODULE_NAMES = new Set<string>([
  'mod.courses',
  'mod.learning',
  'mod.assessments',
  'mod.certificates',
  'mod.zoom-live',
  'mod.community',
  'mod.fundae',
  'mod.ai-tutor',
  'mod.ai-grader',
  'mod.ai-content',
  'mod.theming',
  'mod.notifications',
]);

/// Origen de instalación (DISC-002). Determina badge y nivel de confianza.
export type ModuleSource = 'MARKETPLACE_OFFICIAL' | 'MARKETPLACE_COMMUNITY' | 'DIRECT_UPLOAD';

export interface ValidatedPackage {
  manifest: ModuleManifest;
  /// JWT compact tal cual viene en el ZIP. NULL si firma inválida/ausente.
  manifestJwt: string | null;
  /// SHA-256 hex del paquete tal cual fue subido (antes de extraer).
  /// Se persiste para detectar tampering al releerlo del object storage.
  packageSha256: string;
  packageSizeBytes: number;
  /// Origen de la instalación (DISC-002).
  source: ModuleSource;
  /// `true` si la firma ES256 fue verificada correctamente.
  signatureVerified: boolean;
  /// Error de firma si `signatureVerified=false`. Para mostrar en UI.
  signatureError?: string;
}

@Injectable()
export class ModulePackageService {
  private readonly logger = new Logger(ModulePackageService.name);

  constructor(private readonly signatures: ModuleSignatureService) {}

  /// Pipeline de validación de un `*.zip`. NO escribe a disco ni a BD;
  /// solo valida y devuelve los datos extraídos para que el caller decida
  /// qué hacer con ellos (persistir en S3, abrir transacción Prisma, etc.).
  ///
  /// Pasos:
  ///   1. Tamaño del buffer.
  ///   2. ZIP parseable.
  ///   3. Ficheros requeridos presentes.
  ///   4. JWT verify (firma KMS + iss + aud + schema del manifest).
  ///   5. Coherencia name ↔ tablePrefix ↔ apiNamespace.
  ///   6. name no es un slug reservado (built-in del core).
  ///   7. coreVersionRequired compatible con el core que corre.
  async validatePackage(
    packageBuffer: Buffer,
    options: { coreVersion: string },
  ): Promise<ValidatedPackage> {
    if (packageBuffer.length === 0) {
      throw new MarketplacePackageError('PACKAGE_INVALID_ZIP', 'El paquete está vacío.');
    }
    if (packageBuffer.length > MAX_PACKAGE_BYTES) {
      throw new MarketplacePackageError(
        'PACKAGE_TOO_LARGE',
        `Paquete excede el límite de ${MAX_PACKAGE_BYTES} bytes.`,
        { sizeBytes: packageBuffer.length, maxBytes: MAX_PACKAGE_BYTES },
      );
    }

    let zip: AdmZip;
    try {
      zip = new AdmZip(packageBuffer);
    } catch (err) {
      throw new MarketplacePackageError(
        'PACKAGE_INVALID_ZIP',
        `No se pudo abrir el ZIP: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const entries = new Map<string, AdmZip.IZipEntry>();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      entries.set(entry.entryName, entry);
    }

    for (const required of REQUIRED_FILES) {
      if (!entries.has(required)) {
        throw new MarketplacePackageError(
          'PACKAGE_MISSING_FILE',
          `Falta el fichero "${required}" en el paquete.`,
          { missingFile: required },
        );
      }
    }

    const manifestJwt = entries.get('manifest.jwt')!.getData().toString('utf8').trim();

    // DISC-002: Intentamos verificar la firma pero no bloqueamos si falla.
    // Solo guardamos el resultado para determinar el source y mostrar warning.
    const verifyResult = await this.signatures.tryVerifyManifestJwt(manifestJwt);
    const { verified: signatureVerified, manifest, signatureError } = verifyResult;

    // Determinar el source basándose en la firma y el vendor
    let source: ModuleSource;
    if (signatureVerified) {
      // Firma válida: es de marketplace
      source = manifest.vendor === 'didacta' ? 'MARKETPLACE_OFFICIAL' : 'MARKETPLACE_COMMUNITY';
    } else {
      // Sin firma válida: subida directa
      source = 'DIRECT_UPLOAD';
    }

    const consistencyErrors = validateManifestConsistency(manifest);
    if (consistencyErrors.length > 0) {
      throw new MarketplacePackageError(
        'MANIFEST_CONSISTENCY_INVALID',
        `Manifest incoherente: ${consistencyErrors.join('; ')}`,
        { errors: consistencyErrors },
      );
    }

    // DISC-001.5: Validar que las surfaces declaradas tienen sus bundles
    const zipEntries = new Set(entries.keys());
    const surfaceErrors = validateSurfaceBundles(manifest, zipEntries);
    if (surfaceErrors.length > 0) {
      throw new MarketplacePackageError(
        'SURFACE_BUNDLE_MISSING',
        `Bundles UI faltantes: ${surfaceErrors.join('; ')}`,
        { errors: surfaceErrors },
      );
    }

    if (RESERVED_MODULE_NAMES.has(manifest.name)) {
      throw new MarketplacePackageError(
        'NAME_RESERVED',
        `El nombre "${manifest.name}" está reservado para un módulo built-in.`,
        { name: manifest.name },
      );
    }

    if (!isCoreVersionCompatible(manifest.coreVersionRequired, options.coreVersion)) {
      throw new MarketplacePackageError(
        'CORE_VERSION_INCOMPATIBLE',
        `El módulo requiere core ${manifest.coreVersionRequired}; instancia corre ${options.coreVersion}.`,
        { coreVersionRequired: manifest.coreVersionRequired, coreVersion: options.coreVersion },
      );
    }

    return {
      manifest,
      manifestJwt: signatureVerified ? manifestJwt : null,
      packageSha256: createHash('sha256').update(packageBuffer).digest('hex'),
      packageSizeBytes: packageBuffer.length,
      source,
      signatureVerified,
      signatureError,
    };
  }
}

/// Resolver de `coreVersionRequired` (rango SemVer) contra la versión actual
/// de la instancia. Implementación mínima: soporta `^X.Y.Z`, `~X.Y.Z` y
/// versión exacta. Cualquier otro operador (`>=`, ranges con AND) se trata
/// como restrictivo para no admitir un módulo que no podemos validar.
///
/// MOTIVACIÓN de no usar `semver` aquí: añadir una dep para tres reglas
/// concretas no compensa. Si la lógica crece, swap a `semver` es trivial.
export function isCoreVersionCompatible(required: string, actual: string): boolean {
  const r = required.trim();
  const a = actual.trim();
  const exact = /^(\d+)\.(\d+)\.(\d+)$/;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/;
  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/;

  const actualParsed = a.match(exact);
  if (!actualParsed) return false;
  const [, aMajor, aMinor, aPatch] = actualParsed.map(Number) as [number, number, number, number];

  const exactMatch = r.match(exact);
  if (exactMatch) {
    return r === a;
  }

  const caretMatch = r.match(caret);
  if (caretMatch) {
    const [, rMajor, rMinor, rPatch] = caretMatch.map(Number) as [number, number, number, number];
    if (aMajor !== rMajor) return false;
    if (aMinor < rMinor) return false;
    if (aMinor === rMinor && aPatch < rPatch) return false;
    return true;
  }

  const tildeMatch = r.match(tilde);
  if (tildeMatch) {
    const [, rMajor, rMinor, rPatch] = tildeMatch.map(Number) as [number, number, number, number];
    if (aMajor !== rMajor) return false;
    if (aMinor !== rMinor) return false;
    if (aPatch < rPatch) return false;
    return true;
  }

  return false;
}
