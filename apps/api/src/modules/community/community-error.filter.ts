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
import { CommunityError } from '@didacta/mod-community';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  POST_NOT_FOUND: HttpStatus.NOT_FOUND,
  COMMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  REACTION_TARGET_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_AUTHOR: HttpStatus.FORBIDDEN,
  NESTED_REPLIES_TOO_DEEP: HttpStatus.UNPROCESSABLE_ENTITY,
  PARENT_COMMENT_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_MODERATOR: HttpStatus.FORBIDDEN,
  TAG_NOT_FOUND: HttpStatus.NOT_FOUND,
  TAG_NAME_EXISTS: HttpStatus.CONFLICT,
  SPACE_NOT_FOUND: HttpStatus.NOT_FOUND,
  SPACE_EXISTS: HttpStatus.CONFLICT,
  SPACE_NOT_DELETABLE: HttpStatus.CONFLICT,
};

@Catch(CommunityError)
export class CommunityErrorFilter implements ExceptionFilter<CommunityError> {
  catch(exception: CommunityError, host: ArgumentsHost) {
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
