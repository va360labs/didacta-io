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
import { CertificatesError } from '@didacta/mod-certificates';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../../common/module-error-body';

const STATUS_BY_CODE: Record<string, number> = {
  CERTIFICATE_NOT_FOUND: HttpStatus.NOT_FOUND,
  CERTIFICATE_ALREADY_ISSUED: HttpStatus.CONFLICT,
  TEMPLATE_NOT_FOUND: HttpStatus.NOT_FOUND,
  TEMPLATE_NAME_TAKEN: HttpStatus.CONFLICT,
  TEMPLATE_IN_USE: HttpStatus.CONFLICT,
  TEMPLATE_IS_DEFAULT: HttpStatus.CONFLICT,
};

@Catch(CertificatesError)
export class CertificatesErrorFilter implements ExceptionFilter<CertificatesError> {
  catch(exception: CertificatesError, host: ArgumentsHost) {
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
