/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { validatePackageLayout, type PackageEntries } from '@didacta/module-package-spec';
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
export const REQUIRED_FILES = ['manifest.jwt', 'package.json', 'dist/index.js'] as const;

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
    const layoutEntries = new Map<string, Buffer>();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      entries.set(entry.entryName, entry);
      layoutEntries.set(entry.entryName, entry.getData());
    }

    // Gate estructural del spec @didacta/module-package-spec (ADR-013).
    // Es la única fuente de verdad para layout: subdirs prohibidos en
    // prisma/migrations/, extensiones permitidas, path safety, tamaño,
    // ficheros requeridos. El packager (oficial o de terceros) genera
    // contra el mismo spec, así que la simetría está garantizada.
    const layout = validatePackageLayout(layoutEntries as PackageEntries);
    if (!layout.valid) {
      // Reportamos el primer error con su código nativo (mismo
      // MarketplaceErrorCode que esperan los handlers HTTP), pero
      // adjuntamos la lista completa para que la UI/debug muestre todo.
      const first = layout.errors[0]!;
      throw new MarketplacePackageError(first.code, first.message, {
        ...first.details,
        path: first.path,
        allErrors: layout.errors,
      });
    }

    // Defense-in-depth: el spec ya cubre REQUIRED_FILES, pero mantenemos
    // el check explícito por si en el futuro evoluciona el spec y queremos
    // un fail-loud aquí en lugar de que el bug pase silencioso.
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
/// de la instancia. Implementación mínima: soporta `^X.Y.Z[-prerelease]`,
/// `~X.Y.Z[-prerelease]` y versión exacta con pre-releases opcionales.
/// Cualquier otro operador (`>=`, ranges con AND) se trata como restrictivo
/// para no admitir un módulo que no podemos validar.
///
/// MOTIVACIÓN de no usar `semver` aquí: añadir una dep para tres reglas
/// concretas no compensa. Si la lógica crece, swap a `semver` es trivial.
///
/// PRE-RELEASE SUPPORT (alpha.X, beta.X, rc.X):
/// - `^0.0.1-alpha.0` matchea `0.0.1-alpha.41` (same base, prerelease >= required)
/// - `^0.0.1` matchea `0.0.1-alpha.41` (base version compatible, prerelease ignored)
///
/// SEMVER 0.x: el caret NO abre el rango hacia arriba, igual que en npm.
/// `^0.0.1` solo acepta 0.0.1, y `^0.1.2` acepta >=0.1.2 <0.2.0. Importa
/// porque el core lleva toda su vida en 0.x: tratarlo como 1.x dejaba instalar
/// un módulo empaquetado contra `^0.0.1` sobre un core 0.9.0.
export function isCoreVersionCompatible(required: string, actual: string): boolean {
  const r = required.trim();
  const a = actual.trim();

  // Regex con soporte para pre-release opcional: X.Y.Z o X.Y.Z-prerelease
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
  const caretSemver = /^\^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
  const tildeSemver = /^~(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

  const actualParsed = a.match(semver);
  if (!actualParsed) return false;
  const [, aMajorStr, aMinorStr, aPatchStr, aPrerelease] = actualParsed;
  const aMajor = Number(aMajorStr);
  const aMinor = Number(aMinorStr);
  const aPatch = Number(aPatchStr);

  // Exact match (sin operador): debe coincidir completamente
  const exactMatch = r.match(semver);
  if (exactMatch && !r.startsWith('^') && !r.startsWith('~')) {
    return r === a;
  }

  // Caret (^): mismo major, minor+patch >= required
  const caretMatch = r.match(caretSemver);
  if (caretMatch) {
    const [, rMajorStr, rMinorStr, rPatchStr, rPrerelease] = caretMatch;
    const rMajor = Number(rMajorStr);
    const rMinor = Number(rMinorStr);
    const rPatch = Number(rPatchStr);

    if (aMajor !== rMajor) return false;

    // SemVer 0.x: NO hay compatibilidad hacia arriba, y el caret lo respeta.
    //   `^0.0.1` → solo 0.0.1 (en 0.0.x cada patch puede romper)
    //   `^0.1.2` → >=0.1.2 <0.2.0 (en 0.x.y el minor hace de major)
    // Tratarlo como en 1.x era fail-open: un módulo empaquetado contra
    // `^0.0.1` se instalaba en un core 0.9.0 pese a que entre esos dos minors
    // el contrato pudo cambiar entero. Y el core lleva TODA su vida en 0.x, o
    // sea que este es el caso normal, no el raro.
    if (rMajor === 0) {
      if (aMinor !== rMinor) return false;
      if (rMinor === 0 && aPatch !== rPatch) return false;
      if (aPatch < rPatch) return false;
    } else {
      if (aMinor < rMinor) return false;
      if (aMinor === rMinor && aPatch < rPatch) return false;
    }

    // Si base versions iguales y ambos tienen prerelease, comparar prereleases
    if (aMinor === rMinor && aPatch === rPatch && rPrerelease && aPrerelease) {
      return comparePrerelease(aPrerelease, rPrerelease) >= 0;
    }

    return true;
  }

  // Tilde (~): mismo major+minor, patch >= required
  const tildeMatch = r.match(tildeSemver);
  if (tildeMatch) {
    const [, rMajorStr, rMinorStr, rPatchStr, rPrerelease] = tildeMatch;
    const rMajor = Number(rMajorStr);
    const rMinor = Number(rMinorStr);
    const rPatch = Number(rPatchStr);

    if (aMajor !== rMajor) return false;
    if (aMinor !== rMinor) return false;
    if (aPatch < rPatch) return false;

    // Misma lógica de prerelease que caret
    if (aPatch === rPatch && rPrerelease && aPrerelease) {
      return comparePrerelease(aPrerelease, rPrerelease) >= 0;
    }

    // Tilde es ESTRICTO con prerelease (a diferencia de caret, que es permisivo):
    // un rango con prerelease sólo aplica a prereleases de la MISMA tupla
    // [major,minor,patch]. Si la requerida lleva prerelease, la actual no, y la
    // patch difiere → rechazar (~0.0.1-alpha.0 NO matchea 0.0.2).
    if (rPrerelease && !aPrerelease && aPatch !== rPatch) return false;

    return true;
  }

  return false;
}

/// Compara identificadores de prerelease: alpha.0 vs alpha.41
/// Retorna: negativo si a < b, 0 si iguales, positivo si a > b
/// Sigue SemVer spec: partes numéricas se comparan como números,
/// alfanuméricas como strings, numeric < alphanumeric.
function comparePrerelease(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];

    // Parte faltante es menor (menos partes = versión menor)
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;

    const aNum = parseInt(aPart, 10);
    const bNum = parseInt(bPart, 10);
    const aIsNum = !isNaN(aNum) && String(aNum) === aPart;
    const bIsNum = !isNaN(bNum) && String(bNum) === bPart;

    // Ambos numéricos: comparar como números
    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum - bNum;
      continue;
    }

    // Numérico < alfanumérico (SemVer spec)
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;

    // Ambos alfanuméricos: comparar como strings
    if (aPart !== bPart) return aPart < bPart ? -1 : 1;
  }

  return 0;
}
