import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import {
  canonicalManifestBytes,
  moduleManifestSchema,
  validateManifestConsistency,
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
export const REQUIRED_FILES = [
  'manifest.json',
  'manifest.sig',
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

export interface ValidatedPackage {
  manifest: ModuleManifest;
  signatureB64: string;
  /// SHA-256 hex del paquete tal cual fue subido (antes de extraer).
  /// Se persiste para detectar tampering al releerlo del object storage.
  packageSha256: string;
  packageSizeBytes: number;
  /// Bytes canónicos del manifest tal cual se firmó/verificó. Útil para
  /// re-verificación posterior en otros nodos sin tener que reconstruir
  /// la canonicalización.
  canonicalManifest: Buffer;
}

@Injectable()
export class ModulePackageService {
  private readonly logger = new Logger(ModulePackageService.name);

  constructor(private readonly signatures: ModuleSignatureService) {}

  /// Pipeline de validación de un `*.didactamod`. NO escribe a disco ni a BD;
  /// solo valida y devuelve los datos extraídos para que el caller decida
  /// qué hacer con ellos (persistir en S3, abrir transacción Prisma, etc.).
  ///
  /// Pasos (ADR-009 §3, fases 1-7):
  ///   1. Tamaño del buffer.
  ///   2. ZIP parseable.
  ///   3. Ficheros requeridos presentes.
  ///   4. manifest.json es JSON válido.
  ///   5. Manifest cumple el schema Zod.
  ///   6. Coherencia name ↔ tablePrefix ↔ apiNamespace.
  ///   7. Verificación de firma RSA-PSS-SHA256 contra clave del vendor.
  ///   8. name no es un slug reservado (built-in del core).
  ///
  /// Lanza `MarketplacePackageError` con un `code` estable en cualquier
  /// fallo. La excepción NO se loguea aquí (el caller decide nivel y
  /// contexto) excepto eventos de seguridad muy claros.
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

    const manifestRaw = entries.get('manifest.json')!.getData().toString('utf8');
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw);
    } catch (err) {
      throw new MarketplacePackageError(
        'MANIFEST_INVALID_JSON',
        `manifest.json no es JSON válido: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = moduleManifestSchema.safeParse(manifestJson);
    if (!parsed.success) {
      throw new MarketplacePackageError(
        'MANIFEST_SCHEMA_INVALID',
        'manifest.json no cumple el schema del contrato de módulo.',
        { issues: parsed.error.issues },
      );
    }
    const manifest = parsed.data;

    const consistencyErrors = validateManifestConsistency(manifest);
    if (consistencyErrors.length > 0) {
      throw new MarketplacePackageError(
        'MANIFEST_CONSISTENCY_INVALID',
        `Manifest incoherente: ${consistencyErrors.join('; ')}`,
        { errors: consistencyErrors },
      );
    }

    if (RESERVED_MODULE_NAMES.has(manifest.name)) {
      throw new MarketplacePackageError(
        'NAME_RESERVED',
        `El nombre "${manifest.name}" está reservado para un módulo built-in.`,
        { name: manifest.name },
      );
    }

    const canonical = canonicalManifestBytes(manifest);
    const signatureB64 = entries.get('manifest.sig')!.getData().toString('utf8').trim();
    this.signatures.verifyManifestSignature(manifest.vendor, canonical, signatureB64);

    if (!isCoreVersionCompatible(manifest.coreVersionRequired, options.coreVersion)) {
      throw new MarketplacePackageError(
        'CORE_VERSION_INCOMPATIBLE',
        `El módulo requiere core ${manifest.coreVersionRequired}; instancia corre ${options.coreVersion}.`,
        { coreVersionRequired: manifest.coreVersionRequired, coreVersion: options.coreVersion },
      );
    }

    return {
      manifest,
      signatureB64,
      packageSha256: createHash('sha256').update(packageBuffer).digest('hex'),
      packageSizeBytes: packageBuffer.length,
      canonicalManifest: canonical,
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
