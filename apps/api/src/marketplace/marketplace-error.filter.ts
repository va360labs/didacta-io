import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { MarketplacePackageError, type MarketplaceErrorCode } from './module-package.errors';

/// Mapea cada código de `MarketplacePackageError` al status HTTP que el
/// equipo web espera (ver `docs/MARKETPLACE-WEB-SPEC.md` §5.2). El cuerpo
/// devuelto siempre incluye `code` para que el cliente programe contra él
/// sin parsear el mensaje.
const STATUS_BY_CODE: Record<MarketplaceErrorCode, number> = {
  PACKAGE_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE, // 413
  PACKAGE_INVALID_ZIP: HttpStatus.BAD_REQUEST, // 400
  PACKAGE_MISSING_FILE: HttpStatus.BAD_REQUEST, // 400
  MANIFEST_INVALID_JSON: HttpStatus.BAD_REQUEST, // 400
  MANIFEST_SCHEMA_INVALID: HttpStatus.BAD_REQUEST, // 400
  MANIFEST_CONSISTENCY_INVALID: HttpStatus.BAD_REQUEST, // 400
  SIGNATURE_INVALID: HttpStatus.UNPROCESSABLE_ENTITY, // 422
  SIGNATURE_VERIFY_FAILED: HttpStatus.UNPROCESSABLE_ENTITY, // 422
  VENDOR_NOT_TRUSTED: HttpStatus.FORBIDDEN, // 403
  CORE_VERSION_INCOMPATIBLE: HttpStatus.PRECONDITION_FAILED, // 412
  NAME_RESERVED: HttpStatus.CONFLICT, // 409
  ALREADY_INSTALLED: HttpStatus.CONFLICT, // 409
  NOT_FOUND: HttpStatus.NOT_FOUND, // 404
  STORAGE_FAILED: HttpStatus.BAD_GATEWAY, // 502
  MODULE_LINT_FAILED: HttpStatus.UNPROCESSABLE_ENTITY, // 422
  MODULE_BOOT_FAILED: HttpStatus.UNPROCESSABLE_ENTITY, // 422
  SURFACE_BUNDLE_MISSING: HttpStatus.UNPROCESSABLE_ENTITY, // 422
};

@Catch(MarketplacePackageError)
export class MarketplaceErrorFilter implements ExceptionFilter<MarketplacePackageError> {
  private readonly logger = new Logger(MarketplaceErrorFilter.name);

  catch(exception: MarketplacePackageError, host: ArgumentsHost): void {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();

    // Eventos de seguridad merecen log explícito: el operador necesita verlos
    // en el dashboard para detectar intentos repetidos de subida con firma
    // mala (posible compromiso de la clave del vendor).
    if (
      exception.code === 'SIGNATURE_VERIFY_FAILED' ||
      exception.code === 'VENDOR_NOT_TRUSTED'
    ) {
      this.logger.warn(`Marketplace · evento de seguridad: ${exception.code} — ${exception.message}`);
    }

    reply.status(status).send({
      statusCode: status,
      code: exception.code,
      message: exception.message,
      details: exception.details,
    });
  }
}
