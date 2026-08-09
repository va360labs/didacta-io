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
import { CoursesError } from '@didacta/mod-courses';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  COURSE_NOT_FOUND: HttpStatus.NOT_FOUND,
  COURSE_SLUG_EXISTS: HttpStatus.CONFLICT,
  COURSE_ALREADY_PUBLISHED: HttpStatus.CONFLICT,
  COURSE_NO_LESSONS: HttpStatus.UNPROCESSABLE_ENTITY,
  COURSE_PUBLISH_VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(CoursesError)
export class CoursesErrorFilter implements ExceptionFilter<CoursesError> {
  catch(exception: CoursesError, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = moduleErrorBody(exception, status, {
      ...(exception.code === 'COURSE_PUBLISH_VALIDATION_FAILED' && 'reasons' in exception
        ? { reasons: (exception as unknown as { reasons: string[] }).reasons }
        : {}),
    });
    if (host.getType() === 'http') {
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
