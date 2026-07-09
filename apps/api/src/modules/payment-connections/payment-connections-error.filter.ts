import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PaymentConnectionsError } from '@didacta/mod-payment-connections';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  PAYMENT_CONNECTIONS_NOT_FOUND: HttpStatus.NOT_FOUND,
  PAYMENT_CONNECTIONS_ALREADY_EXISTS: HttpStatus.CONFLICT,
  PAYMENT_CONNECTIONS_PROVIDER_NOT_SUPPORTED: HttpStatus.UNPROCESSABLE_ENTITY,
  PAYMENT_CONNECTIONS_STRIPE_KEY_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  PAYMENT_CONNECTIONS_STRIPE_API_ERROR: HttpStatus.BAD_GATEWAY,
  PAYMENT_CONNECTIONS_PORTAL_UNAVAILABLE: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(PaymentConnectionsError)
export class PaymentConnectionsErrorFilter implements ExceptionFilter<PaymentConnectionsError> {
  catch(exception: PaymentConnectionsError, host: ArgumentsHost) {
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
