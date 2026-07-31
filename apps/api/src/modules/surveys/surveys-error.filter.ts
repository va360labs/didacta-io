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
import { SurveysError } from '@didacta/mod-surveys';

const STATUS_BY_CODE: Record<string, number> = {
  SURVEYS_NOT_FOUND: HttpStatus.NOT_FOUND,
  SURVEYS_CLOSED: HttpStatus.CONFLICT,
  SURVEYS_ALREADY_RESPONDED: HttpStatus.CONFLICT,
  SURVEYS_INVALID_ANSWER: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(SurveysError)
export class SurveysErrorFilter implements ExceptionFilter<SurveysError> {
  catch(exception: SurveysError, host: ArgumentsHost) {
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
