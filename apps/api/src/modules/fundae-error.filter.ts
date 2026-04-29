import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FundaeError } from '@didacta/mod-fundae';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  FUNDAE_ACTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  FUNDAE_CODIGO_DUPLICADO: HttpStatus.CONFLICT,
  FUNDAE_FECHAS_INVALIDAS: HttpStatus.UNPROCESSABLE_ENTITY,
  FUNDAE_COURSE_NOT_IN_TENANT: HttpStatus.UNPROCESSABLE_ENTITY,
  FUNDAE_BLOCK_NOT_FOUND: HttpStatus.NOT_FOUND,
  FUNDAE_BLOCK_HOURS_EXCEED: HttpStatus.UNPROCESSABLE_ENTITY,
  FUNDAE_BLOCK_ORDINAL_DUPLICADO: HttpStatus.CONFLICT,
  FUNDAE_PARTICIPANT_NOT_IN_ACTION: HttpStatus.NOT_FOUND,
  FUNDAE_ACTION_WITHOUT_COURSE: HttpStatus.UNPROCESSABLE_ENTITY,
  FUNDAE_COMPANY_NOT_FOUND: HttpStatus.NOT_FOUND,
  FUNDAE_COMPANY_NIF_DUPLICADO: HttpStatus.CONFLICT,
  FUNDAE_COMPANY_TIENE_GRUPOS_ACTIVOS: HttpStatus.CONFLICT,
  FUNDAE_RLPT_NOT_FOUND: HttpStatus.NOT_FOUND,
  FUNDAE_RLPT_NOTIFICACION_INICIAL_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  FUNDAE_RLPT_PLAZO_NO_CUMPLIDO: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(FundaeError)
export class FundaeErrorFilter implements ExceptionFilter<FundaeError> {
  catch(exception: FundaeError, host: ArgumentsHost) {
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
