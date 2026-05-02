import { Injectable, Logger } from '@nestjs/common';
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { MarketplacePackageError } from './module-package.errors';

/// Verifica firmas RSA-PSS-SHA256 de los manifests de paquetes `*.didactamod`.
///
/// Configuración:
///   - `MARKETPLACE_TRUSTED_VENDOR_KEYS_VA360`: clave pública PEM (RSA, 2048+) del
///     vendor `va360`. Si falta, el servicio rechaza cualquier paquete VA360
///     con `VENDOR_NOT_TRUSTED`.
///
/// Por qué RSA-PSS y no Ed25519: para el FORMATO del paquete (firma del
/// manifest dentro del ZIP) usamos RSA-PSS porque el ecosistema OpenSSL/HSM
/// de los clientes self-host lo soporta universalmente. Para el CANAL
/// web→instancia (push install) usamos Ed25519 (otro vector, otra clave) —
/// ver `docs/MARKETPLACE-WEB-SPEC.md` §5.2. Son dos firmas distintas que
/// protegen capas distintas.

export const TRUSTED_VENDORS = ['va360'] as const;
export type TrustedVendor = (typeof TRUSTED_VENDORS)[number];

const RSA_MIN_MODULUS_BITS = 2048;
const SALT_LENGTH = 32; // SHA-256 digest length, recomendado para RSA-PSS

@Injectable()
export class ModuleSignatureService {
  private readonly logger = new Logger(ModuleSignatureService.name);
  private readonly vendorKeys: Map<TrustedVendor, KeyObject> = new Map();

  onModuleInit(): void {
    for (const vendor of TRUSTED_VENDORS) {
      const envName = `MARKETPLACE_TRUSTED_VENDOR_KEYS_${vendor.toUpperCase()}`;
      const pem = process.env[envName];
      if (!pem || pem.trim() === '') {
        this.logger.warn(
          `Vendor "${vendor}" sin clave pública configurada (env ${envName}). ` +
            `Los paquetes firmados por este vendor serán rechazados con VENDOR_NOT_TRUSTED.`,
        );
        continue;
      }
      try {
        const key = createPublicKey({ key: pem, format: 'pem' });
        this.assertRsaKey(vendor, key);
        this.vendorKeys.set(vendor, key);
        this.logger.log(`Vendor "${vendor}" registrado con clave pública RSA.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`No se pudo cargar la clave del vendor "${vendor}": ${msg}`);
      }
    }
  }

  /// Devuelve true si el servicio confía en este vendor (clave pública cargada).
  /// Usado por `ModulePackageService` antes de intentar verificar la firma —
  /// permite distinguir "vendor desconocido" de "firma inválida".
  isVendorTrusted(vendor: string): vendor is TrustedVendor {
    return (TRUSTED_VENDORS as readonly string[]).includes(vendor)
      ? this.vendorKeys.has(vendor as TrustedVendor)
      : false;
  }

  /// Verifica la firma RSA-PSS-SHA256 de los bytes canónicos del manifest.
  ///
  /// `signatureB64` es la firma tal cual viene en `manifest.sig` dentro del
  /// ZIP, en base64 estándar (no urlsafe). Lanza `MarketplacePackageError`
  /// con `code='SIGNATURE_VERIFY_FAILED'` si la firma no valida.
  verifyManifestSignature(
    vendor: string,
    canonicalBytes: Buffer,
    signatureB64: string,
  ): void {
    if (!this.isVendorTrusted(vendor)) {
      throw new MarketplacePackageError(
        'VENDOR_NOT_TRUSTED',
        `Vendor "${vendor}" no es de confianza para esta instancia.`,
        { vendor },
      );
    }
    const key = this.vendorKeys.get(vendor as TrustedVendor)!;

    let signature: Buffer;
    try {
      signature = Buffer.from(signatureB64, 'base64');
    } catch {
      throw new MarketplacePackageError('SIGNATURE_INVALID', 'manifest.sig no es base64 válido.');
    }
    if (signature.length === 0) {
      throw new MarketplacePackageError('SIGNATURE_INVALID', 'manifest.sig vacío.');
    }

    const verifier = createVerify('sha256');
    verifier.update(canonicalBytes);
    verifier.end();
    const ok = verifier.verify(
      { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: SALT_LENGTH },
      signature,
    );
    if (!ok) {
      throw new MarketplacePackageError(
        'SIGNATURE_VERIFY_FAILED',
        'La firma del manifest no valida con la clave pública del vendor.',
        { vendor },
      );
    }
  }

  private assertRsaKey(vendor: TrustedVendor, key: KeyObject): void {
    if (key.asymmetricKeyType !== 'rsa') {
      throw new Error(`vendor "${vendor}": se esperaba RSA, recibido ${key.asymmetricKeyType}`);
    }
    const modulus = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (modulus < RSA_MIN_MODULUS_BITS) {
      throw new Error(
        `vendor "${vendor}": módulo RSA insuficiente (${modulus} bits, mínimo ${RSA_MIN_MODULUS_BITS}).`,
      );
    }
  }
}
