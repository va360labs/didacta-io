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
import { AiTutorError } from '@didacta/mod-ai-tutor';
import { AiGatewayError } from '../../ai/types/contracts';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  // mod.ai-tutor
  AI_TUTOR_COURSE_NOT_INDEXED: HttpStatus.NOT_FOUND,
  AI_TUTOR_COURSE_NOT_PUBLISHED: HttpStatus.UNPROCESSABLE_ENTITY,
  AI_TUTOR_COURSE_ACCESS_DENIED: HttpStatus.FORBIDDEN,
  AI_TUTOR_DAILY_QUESTION_QUOTA: HttpStatus.TOO_MANY_REQUESTS,
  AI_TUTOR_TOKEN_QUOTA_EXCEEDED: HttpStatus.TOO_MANY_REQUESTS,
  AI_TUTOR_MESSAGE_NOT_FOUND: HttpStatus.NOT_FOUND,
  AI_TUTOR_CORRECTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR: HttpStatus.BAD_GATEWAY,
  AI_TUTOR_CHAT_PROVIDER_ERROR: HttpStatus.BAD_GATEWAY,
  // ai-gateway
  AI_PROVIDER_NOT_CONFIGURED: HttpStatus.FAILED_DEPENDENCY,
  AI_PROVIDER_UNAVAILABLE: HttpStatus.BAD_GATEWAY,
  AI_PROVIDER_RATE_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  AI_PROVIDER_AUTH: HttpStatus.FAILED_DEPENDENCY,
  AI_PROVIDER_UNSUPPORTED_CAPABILITY: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(AiTutorError, AiGatewayError)
export class AiTutorErrorFilter implements ExceptionFilter<AiTutorError | AiGatewayError> {
  catch(exception: AiTutorError | AiGatewayError, host: ArgumentsHost) {
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
