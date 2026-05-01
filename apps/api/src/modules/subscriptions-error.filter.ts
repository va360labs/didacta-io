import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { SubscriptionsError } from '@didacta/mod-subscriptions';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  SUBSCRIPTIONS_NOT_FOUND: HttpStatus.NOT_FOUND,
  SUBSCRIPTIONS_ALREADY_ACTIVE: HttpStatus.CONFLICT,
  SUBSCRIPTIONS_PRICE_NOT_RECURRING: HttpStatus.UNPROCESSABLE_ENTITY,
  SUBSCRIPTIONS_ACCESS_DENIED: HttpStatus.FORBIDDEN,
  SUBSCRIPTIONS_WEBHOOK_SIGNATURE_INVALID: HttpStatus.UNAUTHORIZED,
  SUBSCRIPTIONS_STRIPE_CONFIG_MISSING: HttpStatus.SERVICE_UNAVAILABLE,
  SUBSCRIPTIONS_STRIPE_API_ERROR: HttpStatus.BAD_GATEWAY,
};

@Catch(SubscriptionsError)
export class SubscriptionsErrorFilter implements ExceptionFilter<SubscriptionsError> {
  catch(exception: SubscriptionsError, host: ArgumentsHost) {
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
