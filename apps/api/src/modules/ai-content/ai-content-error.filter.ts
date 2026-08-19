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
import { AiContentError } from '@didacta/mod-ai-content';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  AI_CONTENT_DRAFT_NOT_FOUND: HttpStatus.NOT_FOUND,
  AI_CONTENT_DRAFT_NOT_IN_DRAFT: HttpStatus.CONFLICT,
  AI_CONTENT_LESSON_TEXT_EMPTY: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_CONTENT_PROVIDER_ERROR: HttpStatus.SERVICE_UNAVAILABLE,
  // La respuesta del modelo se cortó por el techo de tokens: no es culpa del
  // proveedor ni del cliente, es contenido demasiado largo para el límite.
  AI_CONTENT_TRUNCATED: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_CONTENT_INVALID_JSON: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(AiContentError)
export class AiContentErrorFilter implements ExceptionFilter<AiContentError> {
  catch(exception: AiContentError, host: ArgumentsHost) {
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
