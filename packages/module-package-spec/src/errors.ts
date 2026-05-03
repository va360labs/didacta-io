/// Códigos de error que el spec puede emitir. Subconjunto estricto de
/// `MarketplaceErrorCode` del backend (apps/api/src/marketplace/module-package.errors.ts).
/// Mantener en sync — el spec NO incluye los códigos que dependen del manifest
/// parseado (MANIFEST_*, SIGNATURE_*, CORE_VERSION_*) porque esos son
/// responsabilidad del pipeline post-layout del backend.
export type PackageSpecErrorCode =
  | 'PACKAGE_TOO_LARGE'
  | 'PACKAGE_INVALID_ZIP'
  | 'PACKAGE_MISSING_FILE'
  | 'MODULE_LINT_FAILED';

export interface PackageSpecError {
  readonly code: PackageSpecErrorCode;
  readonly message: string;
  /// Path dentro del ZIP que disparó el error, si aplica.
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PackageSpecWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/// Helper para construir errores con shape consistente.
export function makeError(
  code: PackageSpecErrorCode,
  message: string,
  extra: { path?: string; details?: Record<string, unknown> } = {},
): PackageSpecError {
  return {
    code,
    message,
    ...(extra.path !== undefined && { path: extra.path }),
    ...(extra.details !== undefined && { details: extra.details }),
  };
}
