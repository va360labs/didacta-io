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
import { GamificationError } from '@didacta/mod-gamification';
import { moduleErrorBody } from '../../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  GAMIFICATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  GAMIFICATION_VALIDATION: HttpStatus.UNPROCESSABLE_ENTITY,
  GAMIFICATION_CHALLENGE_CLOSED: HttpStatus.CONFLICT,
  GAMIFICATION_PERK_UNAVAILABLE: HttpStatus.CONFLICT,
  GAMIFICATION_ALREADY_SUBMITTED: HttpStatus.CONFLICT,
  GAMIFICATION_ALREADY_REVIEWED: HttpStatus.CONFLICT,
  GAMIFICATION_CONFLICT: HttpStatus.CONFLICT,
};

@Catch(GamificationError)
export class GamificationErrorFilter implements ExceptionFilter<GamificationError> {
  catch(exception: GamificationError, host: ArgumentsHost) {
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
