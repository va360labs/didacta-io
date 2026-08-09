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
import { LearningError } from '@didacta/mod-learning';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  ALREADY_ENROLLED: HttpStatus.CONFLICT,
  ENROLLMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  INVITATION_INVALID: HttpStatus.BAD_REQUEST,
  COURSE_NOT_PUBLISHED: HttpStatus.UNPROCESSABLE_ENTITY,
  LESSON_LOCKED: HttpStatus.FORBIDDEN,
  // Lección fuera del límite del periodo de prueba de la membresía: se
  // desbloquea pagando (el front pinta el CTA "Pagar ahora"), no por fecha.
  TRIAL_CONTENT_LOCKED: HttpStatus.FORBIDDEN,
  SCORM_PACKAGE_INVALID: HttpStatus.BAD_REQUEST,
  SCORM_LESSON_TYPE_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  SCORM_PACKAGE_NOT_FOUND: HttpStatus.NOT_FOUND,
};

@Catch(LearningError)
export class LearningErrorFilter implements ExceptionFilter<LearningError> {
  catch(exception: LearningError, host: ArgumentsHost) {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = moduleErrorBody(exception, status);
    if (host.getType() === 'http') {
      void host.switchToHttp().getResponse<FastifyReply>().status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
