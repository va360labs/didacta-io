/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PayoutsError, PlatformStripeApiError } from '@didacta/mod-payouts';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../../common/module-error-body';

/** Código de dominio → HTTP. Lo que no está aquí es 400. */
export const PAYOUTS_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  PAYOUTS_COUNTRY_UNSUPPORTED: HttpStatus.UNPROCESSABLE_ENTITY,
  PAYOUTS_ENTITY_TYPE_INVALID: HttpStatus.BAD_REQUEST,
  PAYOUTS_INVALID_FEE_BPS: HttpStatus.BAD_REQUEST,
  PAYOUTS_PRICE_CURRENCY: HttpStatus.UNPROCESSABLE_ENTITY,
  PAYOUTS_ACCOUNT_NOT_FOUND: HttpStatus.NOT_FOUND,
  PAYOUTS_ACCOUNT_ALREADY_STARTED: HttpStatus.CONFLICT,
  PAYOUTS_ACCOUNT_ONBOARDING_INCOMPLETE: HttpStatus.CONFLICT,
  PAYOUTS_NOT_READY: HttpStatus.CONFLICT,
  PAYOUTS_SALE_UNRECORDABLE: HttpStatus.CONFLICT,
  PAYOUTS_REF_CONFLICT: HttpStatus.CONFLICT,
  PAYOUTS_SALE_NOT_FOUND: HttpStatus.NOT_FOUND,
  PAYOUTS_SALE_NOT_REFUNDABLE: HttpStatus.CONFLICT,
  PAYOUTS_REFUND_EXCEEDS_REMAINING: HttpStatus.CONFLICT,
  PAYOUTS_REFUND_REJECTED: HttpStatus.CONFLICT,
  PAYOUTS_WEBHOOK_SIGNATURE_INVALID: HttpStatus.UNAUTHORIZED,
  PAYOUTS_WEBHOOK_PAYLOAD_INVALID: HttpStatus.BAD_REQUEST,
  PAYOUTS_WEBHOOK_LIVEMODE_MISMATCH: HttpStatus.BAD_REQUEST,
  PAYOUTS_STRIPE_CONFIG: HttpStatus.SERVICE_UNAVAILABLE,
  PAYOUTS_STRIPE_API_ERROR: HttpStatus.BAD_GATEWAY,
};

/**
 * Errores de `mod.payouts` → HTTP con código estable.
 *
 * Un error de Stripe sin respuesta o reintentable (red, 409 de bloqueo, 429,
 * 5xx) es 503: es transitorio y el webhook de Stripe debe reintentar. El resto
 * de errores de Stripe son 502. En ningún caso viaja la clave: el `detail` es
 * el mensaje literal de Stripe, que no la contiene.
 */
@Catch(PayoutsError)
export class PayoutsErrorFilter implements ExceptionFilter<PayoutsError> {
  catch(exception: PayoutsError, host: ArgumentsHost) {
    const status =
      exception instanceof PlatformStripeApiError && exception.retryable
        ? HttpStatus.SERVICE_UNAVAILABLE
        : (PAYOUTS_STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST);
    const body = moduleErrorBody(exception, status);
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
