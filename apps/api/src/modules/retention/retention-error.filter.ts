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
import { RetentionError } from '@didacta/mod-retention';
import { moduleErrorBody } from '../../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  RETENTION_AUTOMATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  RETENTION_TEMPLATE_NOT_FOUND: HttpStatus.NOT_FOUND,
  RETENTION_MEMBER_NOT_ELIGIBLE: HttpStatus.UNPROCESSABLE_ENTITY,
  RETENTION_RECOVERY_NOT_CONFIGURED: HttpStatus.CONFLICT,
  RETENTION_BODY_INVALID: HttpStatus.BAD_REQUEST,
  RETENTION_UNKNOWN_VARIABLE: HttpStatus.BAD_REQUEST,
  RETENTION_VARIABLE_NOT_AVAILABLE: HttpStatus.BAD_REQUEST,
  RETENTION_DAYS_INVALID: HttpStatus.BAD_REQUEST,
  RETENTION_SUBJECT_INVALID: HttpStatus.BAD_REQUEST,
  RETENTION_SETTINGS_INVALID: HttpStatus.BAD_REQUEST,
  RETENTION_SENDER_INVALID: HttpStatus.BAD_REQUEST,
};

@Catch(RetentionError)
export class RetentionErrorFilter implements ExceptionFilter<RetentionError> {
  catch(exception: RetentionError, host: ArgumentsHost) {
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
