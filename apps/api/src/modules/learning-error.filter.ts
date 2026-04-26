import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { LearningError } from '@didacta/mod-learning';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  ALREADY_ENROLLED: HttpStatus.CONFLICT,
  ENROLLMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  INVITATION_INVALID: HttpStatus.BAD_REQUEST,
  COURSE_NOT_PUBLISHED: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(LearningError)
export class LearningErrorFilter implements ExceptionFilter<LearningError> {
  catch(exception: LearningError, host: ArgumentsHost) {
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    const body = { statusCode: status, code: exception.code, message: exception.message };
    if (host.getType() === 'http') {
      void host.switchToHttp().getResponse<FastifyReply>().status(status).send(body);
      return;
    }
    throw new HttpException(body, status);
  }
}
