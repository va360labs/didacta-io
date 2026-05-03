import { makeError } from './errors';
import type { PackageSpecError, PackageSpecWarning } from './errors';
import {
  MAX_PACKAGE_BYTES,
  MIGRATIONS_PREFIX,
  MIGRATION_FILENAME_REGEX,
  REQUIRED_FILES,
  UI_BUNDLES_PREFIX,
  type PackageEntries,
  type ValidationResult,
} from './types';

/// Valida que el conjunto de entries de un ZIP cumple el contrato del spec.
///
/// El validador NO parsea ZIPs ni lee filesystem: acepta las entries ya
/// extraídas como Map<path, Buffer>. Esto permite que el caller (backend
/// con adm-zip, packager con su propio writer, herramienta de terceros)
/// use el parser que prefiera y mantiene el paquete zero-deps.
///
/// Reglas verificadas (en orden):
///   1. Tamaño total bajo MAX_PACKAGE_BYTES.
///   2. No path traversal, no backslashes, no paths absolutos.
///   3. Todos los REQUIRED_FILES están presentes.
///   4. Bajo prisma/migrations/: solo .sql planos con nombres del whitelist.
///   5. Bajo dist/ui/: solo .js planos.
///
/// Devuelve `{ valid, errors, warnings }`. Si `errors.length === 0` el
/// paquete es estructuralmente válido. Validaciones de manifest (parsing
/// JWT, schema Zod, firma, coherencia name↔tablePrefix) son responsabilidad
/// del backend post-validación de layout.
export function validatePackageLayout(entries: PackageEntries): ValidationResult {
  const errors: PackageSpecError[] = [];
  const warnings: PackageSpecWarning[] = [];

  // 1. Tamaño total
  let totalBytes = 0;
  for (const buf of entries.values()) totalBytes += buf.length;
  if (totalBytes > MAX_PACKAGE_BYTES) {
    errors.push(
      makeError(
        'PACKAGE_TOO_LARGE',
        `Paquete excede el límite de ${MAX_PACKAGE_BYTES} bytes (actual: ${totalBytes}).`,
        { details: { sizeBytes: totalBytes, maxBytes: MAX_PACKAGE_BYTES } },
      ),
    );
  }

  // 2. Path safety: traversal, backslashes, absolute paths
  for (const path of entries.keys()) {
    const pathError = checkPathSafety(path);
    if (pathError) errors.push(pathError);
  }

  // 3. Required files
  for (const required of REQUIRED_FILES) {
    if (!entries.has(required)) {
      errors.push(
        makeError('PACKAGE_MISSING_FILE', `Falta el fichero "${required}" en el paquete.`, {
          path: required,
          details: { missingFile: required },
        }),
      );
    }
  }

  // 4. prisma/migrations/ rules
  for (const path of entries.keys()) {
    if (!path.startsWith(MIGRATIONS_PREFIX)) continue;
    const tail = path.slice(MIGRATIONS_PREFIX.length);

    if (tail.includes('/') || tail.includes('\\') || tail.includes('..')) {
      errors.push(
        makeError(
          'MODULE_LINT_FAILED',
          `Path de migration inválido: "${path}". Las migrations deben vivir directamente bajo ${MIGRATIONS_PREFIX} (sin subdirectorios).`,
          { path, details: { reason: 'subdir_or_traversal' } },
        ),
      );
      continue;
    }

    if (!MIGRATION_FILENAME_REGEX.test(tail)) {
      errors.push(
        makeError(
          'MODULE_LINT_FAILED',
          `Nombre de migration inválido: "${tail}". Permitido: alfanuméricos, guion, underscore, punto, terminando en .sql.`,
          { path, details: { filename: tail } },
        ),
      );
    }
  }

  // 5. dist/ui/ rules: flat .js bundles
  for (const path of entries.keys()) {
    if (!path.startsWith(UI_BUNDLES_PREFIX)) continue;
    const tail = path.slice(UI_BUNDLES_PREFIX.length);

    if (tail.includes('/') || tail.includes('\\') || tail.includes('..')) {
      errors.push(
        makeError(
          'MODULE_LINT_FAILED',
          `Path de UI bundle inválido: "${path}". Los bundles UI deben vivir directamente bajo ${UI_BUNDLES_PREFIX}.`,
          { path, details: { reason: 'subdir_or_traversal' } },
        ),
      );
      continue;
    }

    if (!tail.endsWith('.js')) {
      errors.push(
        makeError(
          'MODULE_LINT_FAILED',
          `Archivo no-JS en dist/ui/: "${path}". Solo se permiten bundles .js.`,
          { path, details: { reason: 'non_js_file' } },
        ),
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function checkPathSafety(path: string): PackageSpecError | null {
  if (path.length === 0) {
    return makeError('PACKAGE_INVALID_ZIP', 'Entry con path vacío.', { path });
  }
  if (path.includes('..')) {
    return makeError(
      'PACKAGE_INVALID_ZIP',
      `Path traversal detectado en "${path}". Los ZIPs con ".." se rechazan por seguridad (zip-slip).`,
      { path, details: { reason: 'path_traversal' } },
    );
  }
  if (path.startsWith('/')) {
    return makeError(
      'PACKAGE_INVALID_ZIP',
      `Path absoluto en "${path}". Los entries deben ser relativos.`,
      { path, details: { reason: 'absolute_path' } },
    );
  }
  if (path.includes('\\')) {
    return makeError(
      'PACKAGE_INVALID_ZIP',
      `Backslash en "${path}". Los ZIPs deben usar forward slashes — un backslash indica un writer mal configurado.`,
      { path, details: { reason: 'backslash' } },
    );
  }
  // Drive letter (Windows): "C:foo" o "C:\foo" → ya capturado por backslash, pero
  // "C:foo" sin slash también es absoluto. Defensa explícita.
  if (/^[A-Za-z]:/.test(path)) {
    return makeError(
      'PACKAGE_INVALID_ZIP',
      `Drive letter en "${path}". Los entries deben ser relativos sin drive letters.`,
      { path, details: { reason: 'drive_letter' } },
    );
  }
  return null;
}
