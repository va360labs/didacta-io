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
import { BillingError } from '@didacta/mod-billing';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  BILLING_PRODUCT_NOT_FOUND: HttpStatus.NOT_FOUND,
  BILLING_PRODUCT_ALREADY_EXISTS: HttpStatus.CONFLICT,
  BILLING_PRODUCT_INACTIVE: HttpStatus.CONFLICT,
  BILLING_ORDER_NOT_FOUND: HttpStatus.NOT_FOUND,
  BILLING_WEBHOOK_SIGNATURE_INVALID: HttpStatus.UNAUTHORIZED,
  BILLING_STRIPE_CONFIG_MISSING: HttpStatus.SERVICE_UNAVAILABLE,
  BILLING_STRIPE_API_ERROR: HttpStatus.BAD_GATEWAY,
};

@Catch(BillingError)
export class BillingErrorFilter implements ExceptionFilter<BillingError> {
  catch(exception: BillingError, host: ArgumentsHost) {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = {
      statusCode: status,
      code: exception.code,
      message: exception.message,
    };
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
