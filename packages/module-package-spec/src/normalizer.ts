/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { makeError } from './errors';
import type { PackageSpecError, PackageSpecWarning } from './errors';
import {
  MIGRATIONS_PREFIX,
  MIGRATION_FILENAME_REGEX,
  PRISMA_META_FILES,
  type NormalizationResult,
  type NormalizedFile,
  type SourceFile,
} from './types';

const SQL_EXT_REGEX = /\.sql$/i;
const PRISMA_NATIVE_LAYOUT_REGEX = /^prisma\/migrations\/([^/]+)\/migration\.sql$/;
const PRISMA_FLAT_LAYOUT_REGEX = /^prisma\/migrations\/([^/]+\.sql)$/;

/// Convierte el path nativo de Prisma a path plano del ZIP.
///
/// Input:  `prisma/migrations/20260503000000_init/migration.sql`
/// Output: `prisma/migrations/20260503000000_init.sql`
function flattenPrismaNative(relativePath: string): string | null {
  const match = relativePath.match(PRISMA_NATIVE_LAYOUT_REGEX);
  if (!match) return null;
  const dirname = match[1];
  if (!dirname) return null;
  return `${MIGRATIONS_PREFIX}${dirname}.sql`;
}

function isHiddenFile(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return segments.some((s) => s.startsWith('.') && s !== '.' && s !== '..');
}

function isPrismaMeta(relativePath: string): boolean {
  if (!relativePath.startsWith(MIGRATIONS_PREFIX)) return false;
  const tail = relativePath.slice(MIGRATIONS_PREFIX.length);
  return PRISMA_META_FILES.has(tail);
}

/// Normaliza un set de archivos del filesystem del dev al layout canónico
/// del ZIP. Esta función es la frontera entre lo que el dev escribe (libre,
/// flexible, varios layouts) y lo que el spec acepta (estricto, plano).
///
/// Reglas:
///   1. `prisma/migrations/<ts>_<name>/migration.sql` → `prisma/migrations/<ts>_<name>.sql`
///   2. `prisma/migrations/<ts>_<name>.sql` → conserva path
///   3. `prisma/migrations/migration_lock.toml` → strip
///   4. `prisma/migrations/README.md` → strip
///   5. Archivos ocultos en cualquier nivel → strip
///   6. Archivos no-`.sql` en `prisma/migrations/` (que no sean meta) → error fatal
///   7. Subdirs en `prisma/migrations/` que NO sean el patrón Prisma nativo → error fatal
///   8. Filenames con caracteres ilegales tras flatten → error fatal
///   9. Colisiones de path final tras flatten → error fatal con detalle
///   10. Cualquier otro archivo (fuera de prisma/migrations/) se conserva tal cual
///
/// La función NO escribe ZIPs. Devuelve la lista de archivos finales más
/// errores y warnings. El packager decide qué hacer con ellos.
export function normalizeMigrations(sources: readonly SourceFile[]): NormalizationResult {
  const errors: PackageSpecError[] = [];
  const warnings: PackageSpecWarning[] = [];
  const stripped: string[] = [];
  const files: NormalizedFile[] = [];
  const seenZipPaths = new Map<string, string>(); // zipPath → original relativePath

  for (const src of sources) {
    const rel = src.relativePath;

    // Hidden files anywhere → strip silently
    if (isHiddenFile(rel)) {
      stripped.push(rel);
      continue;
    }

    // Outside prisma/migrations/ → preserve as-is, defer to validator for path checks
    if (!rel.startsWith(MIGRATIONS_PREFIX)) {
      addNormalized(files, seenZipPaths, errors, { zipPath: rel, content: src.content }, rel);
      continue;
    }

    // Prisma meta files → strip
    if (isPrismaMeta(rel)) {
      stripped.push(rel);
      continue;
    }

    // Prisma native layout: flatten
    const flattened = flattenPrismaNative(rel);
    if (flattened !== null) {
      const filename = flattened.slice(MIGRATIONS_PREFIX.length);
      if (!MIGRATION_FILENAME_REGEX.test(filename)) {
        errors.push(
          makeError(
            'MODULE_LINT_FAILED',
            `Nombre de migration inválido tras aplanar: "${filename}". Permitido: alfanuméricos, guion, underscore, punto, terminando en .sql.`,
            { path: rel, details: { flattened, filename } },
          ),
        );
        continue;
      }
      addNormalized(files, seenZipPaths, errors, { zipPath: flattened, content: src.content }, rel);
      continue;
    }

    // Flat layout: must be directly under prisma/migrations/ as a .sql file
    const flatMatch = rel.match(PRISMA_FLAT_LAYOUT_REGEX);
    if (flatMatch) {
      const filename = flatMatch[1]!;
      if (!MIGRATION_FILENAME_REGEX.test(filename)) {
        errors.push(
          makeError(
            'MODULE_LINT_FAILED',
            `Nombre de migration inválido: "${filename}". Permitido: alfanuméricos, guion, underscore, punto, terminando en .sql.`,
            { path: rel, details: { filename } },
          ),
        );
        continue;
      }
      addNormalized(files, seenZipPaths, errors, { zipPath: rel, content: src.content }, rel);
      continue;
    }

    // Subdir bajo prisma/migrations/ que NO es el patrón Prisma nativo (ej.
    // un directorio con varios archivos, o un archivo no-migration.sql en
    // un subdir): error fatal. Nunca silencioso.
    const tail = rel.slice(MIGRATIONS_PREFIX.length);
    if (tail.includes('/')) {
      errors.push(
        makeError(
          'MODULE_LINT_FAILED',
          `Path de migration inválido: "${rel}". Las migrations deben vivir directamente bajo prisma/migrations/ como ` +
            `archivos .sql planos, o seguir el layout Prisma nativo "<timestamp>_<name>/migration.sql" (que el packager aplana automáticamente).`,
          { path: rel, details: { reason: 'unexpected_subdir' } },
        ),
      );
      continue;
    }

    // Archivo directamente bajo prisma/migrations/ que NO es .sql ni meta
    // conocido. Error fatal: el dev probablemente metió algo raro.
    if (!SQL_EXT_REGEX.test(tail)) {
      errors.push(
        makeError(
          'MODULE_LINT_FAILED',
          `Archivo no-SQL en prisma/migrations/: "${rel}". Solo se permiten archivos .sql (los meta de Prisma como migration_lock.toml se strippean automáticamente).`,
          { path: rel, details: { reason: 'non_sql_file', filename: tail } },
        ),
      );
      continue;
    }

    // Fallback (debería ser inalcanzable dado los regex de arriba).
    errors.push(
      makeError('MODULE_LINT_FAILED', `Path no clasificado: "${rel}".`, {
        path: rel,
        details: { reason: 'unclassified' },
      }),
    );
  }

  return { files, errors, warnings, stripped };
}

function addNormalized(
  files: NormalizedFile[],
  seen: Map<string, string>,
  errors: PackageSpecError[],
  file: NormalizedFile,
  originalRelativePath: string,
): void {
  const existing = seen.get(file.zipPath);
  if (existing !== undefined) {
    errors.push(
      makeError(
        'MODULE_LINT_FAILED',
        `Colisión de path en el ZIP tras normalizar: "${file.zipPath}" proviene de dos fuentes distintas: "${existing}" y "${originalRelativePath}". Renombra una de las dos.`,
        {
          path: file.zipPath,
          details: { sources: [existing, originalRelativePath] },
        },
      ),
    );
    return;
  }
  seen.set(file.zipPath, originalRelativePath);
  files.push(file);
}
