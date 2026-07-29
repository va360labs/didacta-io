import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ResourcesError } from '@didacta/mod-resources';

const STATUS_BY_CODE: Record<string, number> = {
  RESOURCES_NOT_FOUND: HttpStatus.NOT_FOUND,
  RESOURCES_VALIDATION: HttpStatus.UNPROCESSABLE_ENTITY,
  RESOURCES_FORBIDDEN: HttpStatus.FORBIDDEN,
};

@Catch(ResourcesError)
export class ResourcesErrorFilter implements ExceptionFilter<ResourcesError> {
  catch(exception: ResourcesError, host: ArgumentsHost) {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = { statusCode: status, code: exception.code, message: exception.message };
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
