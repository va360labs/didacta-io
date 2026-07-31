/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PackageSpecError, PackageSpecWarning } from './errors';

/// Spec version. SemVer del paquete. El backend acepta una ventana
/// de versiones compatibles; los packagers declaran qué versión usaron.
export const SPEC_VERSION = '1.0.0';

/// Tamaño máximo del paquete (bytes). Mirror de MAX_PACKAGE_BYTES del backend.
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

/// Ficheros que un ZIP de módulo DEBE contener. Su ausencia es PACKAGE_MISSING_FILE.
export const REQUIRED_FILES = ['manifest.jwt', 'package.json', 'dist/index.js'] as const;

/// Prefijo del subdir de migrations dentro del ZIP.
export const MIGRATIONS_PREFIX = 'prisma/migrations/';

/// Prefijo del subdir de UI bundles.
export const UI_BUNDLES_PREFIX = 'dist/ui/';

/// Filename whitelist para migrations: solo alfanuméricos, guion, underscore, punto.
export const MIGRATION_FILENAME_REGEX = /^[A-Za-z0-9_.-]+\.sql$/;

/// Archivos meta de Prisma que el packager debe strippear automáticamente
/// del subdir prisma/migrations/. NO son fatal — se ignoran silenciosamente.
export const PRISMA_META_FILES = new Set<string>(['migration_lock.toml', 'README.md']);

/// Entries del ZIP como Map path → Buffer. El validador acepta este shape
/// abstracto en lugar de un Buffer crudo del ZIP, para permitir que cada
/// caller (backend con adm-zip, packager con su propio writer) parsee el
/// ZIP con la lib que prefiera. Mantiene el spec zero-deps.
export type PackageEntries = ReadonlyMap<string, Buffer>;

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly PackageSpecError[];
  readonly warnings: readonly PackageSpecWarning[];
}

/// Input del normalizador: archivos del filesystem del dev tal cual los
/// genera Prisma o el dev escribe a mano. El normalizador decide qué
/// queda dentro del ZIP y bajo qué path.
export interface SourceFile {
  /// Path relativo a la raíz del módulo, con forward slashes.
  /// Ej: 'prisma/migrations/20260503000000_init/migration.sql'
  readonly relativePath: string;
  readonly content: Buffer;
}

/// Output del normalizador: archivo listo para meterse en el ZIP con el
/// path canónico que espera el spec.
export interface NormalizedFile {
  /// Path final dentro del ZIP, con forward slashes.
  /// Ej: 'prisma/migrations/20260503000000_init.sql'
  readonly zipPath: string;
  readonly content: Buffer;
}

export interface NormalizationResult {
  readonly files: readonly NormalizedFile[];
  readonly errors: readonly PackageSpecError[];
  readonly warnings: readonly PackageSpecWarning[];
  /// Archivos del input que el normalizador descartó intencionalmente
  /// (migration_lock.toml, README.md, ocultos). Útil para logging.
  readonly stripped: readonly string[];
}
