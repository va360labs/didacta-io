/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { MessagingError } from '@didacta/mod-messaging';

/**
 * Mapea los errores de dominio de mod.messaging a HTTP con código estable.
 * El frontend humaniza por `code`; el mensaje viaja en español desde el módulo.
 */
const STATUS_BY_CODE: Record<string, number> = {
  MESSAGING_CONVERSATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  MESSAGING_SPACE_NOT_FOUND: HttpStatus.NOT_FOUND,
  MESSAGING_USER_NOT_FOUND: HttpStatus.NOT_FOUND,
  MESSAGING_NOT_PARTICIPANT: HttpStatus.FORBIDDEN,
  MESSAGING_SELF_DM: HttpStatus.UNPROCESSABLE_ENTITY,
  MESSAGING_BODY_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  MESSAGING_STAFF_NO_FACULTY: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(MessagingError)
export class MessagingErrorFilter implements ExceptionFilter<MessagingError> {
  catch(exception: MessagingError, host: ArgumentsHost) {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = { statusCode: status, code: exception.code, message: exception.message };
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
