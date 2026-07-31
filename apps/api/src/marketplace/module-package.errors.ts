/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Errores tipados del pipeline de validación de un `*.zip`.
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
  | 'NAME_RESERVED'
  /// El manifest declara `surfaces` pero faltan los bundles UI correspondientes
  /// en dist/ui/<surface>.js. 422.
  | 'SURFACE_BUNDLE_MISSING'
  /// La misma versión del módulo ya está instalada y `INSTALLED`. No es un
  /// error técnico, pero el endpoint lo expone como 409 para que el cliente
  /// distinga "no-op idempotente" de "instalación nueva".
  | 'ALREADY_INSTALLED'
  /// Recurso no encontrado (ej. `GET /admin/modules/installed/:name` con
  /// nombre que no existe). Mapea a 404.
  | 'NOT_FOUND'
  /// Fallo persistiendo el paquete en object storage. La validación pasó,
  /// pero el blob no llegó al bucket. El row queda `FAILED`. 502 al cliente.
  | 'STORAGE_FAILED'
  /// El lint estático del `dist/index.js` rechazó el código antes del boot
  /// (require fuera de allowlist, eval/Function, import ESM, etc.). 422.
  | 'MODULE_LINT_FAILED'
  /// Fallo al bootear el módulo en la VM aislada (sintaxis, throw inicial,
  /// `module.exports` con shape inválida, timeout). 422.
  | 'MODULE_BOOT_FAILED';

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
