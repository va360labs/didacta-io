import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ZoomLiveError } from '@didacta/mod-zoom-live';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  ZOOM_SESSION_NOT_FOUND: HttpStatus.NOT_FOUND,
  ZOOM_SESSION_ALREADY_ENDED: HttpStatus.CONFLICT,
  ZOOM_SESSION_NOT_OPEN_FOR_REGISTRATION: HttpStatus.CONFLICT,
  ZOOM_NOT_REGISTERED: HttpStatus.FORBIDDEN,
  ZOOM_ATTENDANCE_NOT_AVAILABLE: HttpStatus.CONFLICT,
  ZOOM_COURSE_NOT_IN_TENANT: HttpStatus.UNPROCESSABLE_ENTITY,
  ZOOM_LESSON_NOT_IN_COURSE: HttpStatus.UNPROCESSABLE_ENTITY,
  // El host no existe en la cuenta de Zoom: es un dato mal puesto por quien
  // crea la clase, no un fallo de Zoom (no es 502).
  ZOOM_HOST_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  ZOOM_API_ERROR: HttpStatus.BAD_GATEWAY,
};

@Catch(ZoomLiveError)
export class ZoomLiveErrorFilter implements ExceptionFilter<ZoomLiveError> {
  catch(exception: ZoomLiveError, host: ArgumentsHost) {
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
