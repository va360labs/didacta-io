/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// @didacta/module-package-spec
///
/// Contrato versionado del layout del ZIP de un módulo Didacta. Única
/// fuente de verdad compartida entre el backend (validador) y cualquier
/// packager (skill oficial o herramienta de terceros).
///
/// API pública:
///   - validatePackageLayout(entries) → valida un ZIP ya parseado
///   - normalizeMigrations(sources) → traduce filesystem del dev a layout canónico
///   - SPEC_VERSION, MAX_PACKAGE_BYTES, REQUIRED_FILES → constantes compartidas
///   - Tipos: PackageEntries, ValidationResult, NormalizationResult, etc.

export {
  MODULE_SURFACES,
  AUTHENTICATED_MODULE_SURFACES,
  isModuleSurface,
  type ModuleSurface,
} from './surfaces';
export { validatePackageLayout } from './validator';
export { normalizeMigrations } from './normalizer';
export type { PackageSpecError, PackageSpecErrorCode, PackageSpecWarning } from './errors';
export {
  SPEC_VERSION,
  MAX_PACKAGE_BYTES,
  REQUIRED_FILES,
  MIGRATIONS_PREFIX,
  UI_BUNDLES_PREFIX,
  MIGRATION_FILENAME_REGEX,
  PRISMA_META_FILES,
  type PackageEntries,
  type ValidationResult,
  type NormalizationResult,
  type NormalizedFile,
  type SourceFile,
} from './types';
