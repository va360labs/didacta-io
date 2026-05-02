import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { TenantModulesError, type TenantModulesErrorCode } from './tenant-modules.service';

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
    const body = {
      statusCode: status,
      code: exception.code,
      message: exception.message,
      ...(Object.keys(exception.metadata).length > 0 ? { details: exception.metadata } : {}),
    };
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
