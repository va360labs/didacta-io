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
import { SubscriptionsError } from '@didacta/mod-subscriptions';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  SUBSCRIPTIONS_NOT_FOUND: HttpStatus.NOT_FOUND,
  SUBSCRIPTIONS_ALREADY_ACTIVE: HttpStatus.CONFLICT,
  SUBSCRIPTIONS_PRICE_NOT_RECURRING: HttpStatus.UNPROCESSABLE_ENTITY,
  // El price pedido no es de ese curso. 422 y no 403: no es un problema de
  // permisos del alumno, es que la peticion no cuadra con el catalogo.
  SUBSCRIPTIONS_PRICE_NOT_FOR_COURSE: HttpStatus.UNPROCESSABLE_ENTITY,
  // Webhook adelantado a su fila local: 409 para que Stripe reintente. Un 2xx
  // aqui le diria que ya esta hecho y el evento se perderia.
  SUBSCRIPTIONS_WEBHOOK_OUT_OF_ORDER: HttpStatus.CONFLICT,
  SUBSCRIPTIONS_ACCESS_DENIED: HttpStatus.FORBIDDEN,
  SUBSCRIPTIONS_WEBHOOK_SIGNATURE_INVALID: HttpStatus.UNAUTHORIZED,
  SUBSCRIPTIONS_STRIPE_CONFIG_MISSING: HttpStatus.SERVICE_UNAVAILABLE,
  SUBSCRIPTIONS_STRIPE_API_ERROR: HttpStatus.BAD_GATEWAY,
  MEMBERSHIP_PLAN_INTERVAL_INVALID: HttpStatus.BAD_REQUEST,
  MEMBERSHIP_PLAN_NOT_FOUND: HttpStatus.NOT_FOUND,
  MEMBERSHIP_PAGE_INACTIVE: HttpStatus.NOT_FOUND,
  MEMBERSHIP_CONFIG_INCOMPLETE: HttpStatus.UNPROCESSABLE_ENTITY,
  // "Pagar ahora" sin membresía en trial que activar.
  MEMBERSHIP_NOT_TRIALING: HttpStatus.CONFLICT,
  // Ya tiene una membresía viva: no se le abre un segundo checkout.
  MEMBERSHIP_ALREADY_SUBSCRIBED: HttpStatus.CONFLICT,
};

@Catch(SubscriptionsError)
export class SubscriptionsErrorFilter implements ExceptionFilter<SubscriptionsError> {
  catch(exception: SubscriptionsError, host: ArgumentsHost) {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = moduleErrorBody(exception, status);
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
