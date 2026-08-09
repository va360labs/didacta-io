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
import type { FastifyReply } from 'fastify';
import { TenantModulesError, type TenantModulesErrorCode } from './tenant-modules.service';
import { moduleErrorBody } from '../common/module-error-body';

const STATUS_BY_CODE: Record<TenantModulesErrorCode, number> = {
  MODULE_NOT_FOUND: HttpStatus.NOT_FOUND,
  TENANT_NOT_FOUND: HttpStatus.NOT_FOUND,
  MODULE_HAS_ACTIVE_DEPENDENTS: HttpStatus.CONFLICT,
  CORE_MODULE_NOT_DISABLEABLE: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(TenantModulesError)
export class TenantModulesErrorFilter implements ExceptionFilter<TenantModulesError> {
  catch(exception: TenantModulesError, host: ArgumentsHost) {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = moduleErrorBody(exception, status, {
      ...(Object.keys(exception.metadata).length > 0 ? { details: exception.metadata } : {}),
    });
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
