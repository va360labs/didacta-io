/// Errores tipados del pipeline de validación de un `*.didactamod`.
///
/// Cada error lleva un `code` estable que el endpoint de install traduce a un
/// status HTTP y mensaje legible. La separación de errores tipados permite
/// que los tests aserten sobre `code` sin depender del texto del mensaje.

export type MarketplaceErrorCode =
  | 'PACKAGE_TOO_LARGE'
  | 'PACKAGE_INVALID_ZIP'
  | 'PACKAGE_MISSING_FILE'
  | 'MANIFEST_INVALID_JSON'
  | 'MANIFEST_SCHEMA_INVALID'
  | 'MANIFEST_CONSISTENCY_INVALID'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_VERIFY_FAILED'
  | 'VENDOR_NOT_TRUSTED'
  | 'CORE_VERSION_INCOMPATIBLE'
  | 'NAME_RESERVED';

export class MarketplacePackageError extends Error {
  readonly code: MarketplaceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: MarketplaceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'MarketplacePackageError';
    this.code = code;
    this.details = details;
  }
}
