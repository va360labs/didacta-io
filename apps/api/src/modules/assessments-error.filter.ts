import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AssessmentsError } from '@didacta/mod-assessments';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  QUIZ_NOT_FOUND: HttpStatus.NOT_FOUND,
  QUESTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  ATTEMPT_NOT_FOUND: HttpStatus.NOT_FOUND,
  QUIZ_NOT_PUBLISHED: HttpStatus.UNPROCESSABLE_ENTITY,
  QUIZ_HAS_NO_QUESTIONS: HttpStatus.UNPROCESSABLE_ENTITY,
  QUESTION_HAS_NO_CORRECT_OPTION: HttpStatus.UNPROCESSABLE_ENTITY,
  ATTEMPT_ALREADY_SUBMITTED: HttpStatus.CONFLICT,
  ATTEMPT_EXPIRED: HttpStatus.GONE,
  MAX_ATTEMPTS_REACHED: HttpStatus.CONFLICT,
  ATTEMPT_NOT_PENDING_REVIEW: HttpStatus.CONFLICT,
  GRADE_EXCEEDS_QUESTION_POINTS: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(AssessmentsError)
export class AssessmentsErrorFilter implements ExceptionFilter<AssessmentsError> {
  catch(exception: AssessmentsError, host: ArgumentsHost) {
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
