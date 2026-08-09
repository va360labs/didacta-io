/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AiGraderError } from '@didacta/mod-ai-grader';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  AI_GRADER_RUBRIC_NOT_FOUND: HttpStatus.NOT_FOUND,
  AI_GRADER_SUGGESTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  AI_GRADER_RUBRIC_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_GRADER_QUESTION_NOT_GRADABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_GRADER_ATTEMPT_NOT_PENDING: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_GRADER_PROVIDER_ERROR: HttpStatus.BAD_GATEWAY,
  AI_GRADER_RESPONSE_PARSE_ERROR: HttpStatus.BAD_GATEWAY,
};

@Catch(AiGraderError)
export class AiGraderErrorFilter implements ExceptionFilter<AiGraderError> {
  catch(exception: AiGraderError, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = moduleErrorBody(exception, status);
    if (host.getType() === 'http') {
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
