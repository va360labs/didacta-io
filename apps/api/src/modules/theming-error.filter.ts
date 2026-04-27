import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ThemingError } from '@didacta/mod-theming';
import type { FastifyReply } from 'fastify';

const STATUS_BY_CODE: Record<string, number> = {
  THEMING_INVALID_HUE: HttpStatus.UNPROCESSABLE_ENTITY,
  THEMING_INVALID_SATURATION: HttpStatus.UNPROCESSABLE_ENTITY,
  THEMING_UNSUPPORTED_FONT: HttpStatus.UNPROCESSABLE_ENTITY,
  THEMING_CUSTOM_CSS_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  THEMING_CUSTOM_CSS_UNSAFE: HttpStatus.UNPROCESSABLE_ENTITY,
  THEMING_FOOTER_HTML_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  THEMING_INVALID_URL: HttpStatus.UNPROCESSABLE_ENTITY,
  THEMING_LOGO_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  THEMING_LOGO_NOT_FOUND: HttpStatus.NOT_FOUND,
};

@Catch(ThemingError)
export class ThemingErrorFilter implements ExceptionFilter<ThemingError> {
  catch(exception: ThemingError, host: ArgumentsHost) {
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
