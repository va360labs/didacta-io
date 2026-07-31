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
import { ReferralsError } from '@didacta/mod-referrals';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  // El programa apagado se comporta como "no existe" (mismo criterio que
  // MEMBERSHIP_PAGE_INACTIVE): 404 con código estable para la UI.
  REFERRALS_PROGRAM_INACTIVE: HttpStatus.NOT_FOUND,
  REFERRALS_MEMBERSHIP_REQUIRED: HttpStatus.FORBIDDEN,
  REFERRALS_COMMISSION_NOT_FOUND: HttpStatus.NOT_FOUND,
  REFERRALS_COMMISSION_STATE: HttpStatus.CONFLICT,
  REFERRALS_PAYOUT_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERRALS_CONFIG_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(ReferralsError)
export class ReferralsErrorFilter implements ExceptionFilter<ReferralsError> {
  catch(exception: ReferralsError, host: ArgumentsHost) {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = {
      statusCode: status,
      code: exception.code,
      message: exception.message,
    };
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
