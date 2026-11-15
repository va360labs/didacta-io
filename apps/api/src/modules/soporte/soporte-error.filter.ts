/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { SoporteError } from '@didacta/mod-soporte';
import type { FastifyReply } from 'fastify';
import { moduleErrorBody } from '../../common/module-error-body';

/** Status de cada code; uno que no esté aquí sale como 400. */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  SOPORTE_LIMITE_DIARIO: HttpStatus.TOO_MANY_REQUESTS,
  SOPORTE_TEXTO_CORTO: HttpStatus.BAD_REQUEST,
  SOPORTE_TEXTO_LARGO: HttpStatus.BAD_REQUEST,
  SOPORTE_TIPO_INVALIDO: HttpStatus.BAD_REQUEST,
  SOPORTE_NOTA_LARGA: HttpStatus.BAD_REQUEST,
  SOPORTE_ESTADO_INVALIDO: HttpStatus.BAD_REQUEST,
  SOPORTE_SIN_CAMBIOS: HttpStatus.BAD_REQUEST,
  SOPORTE_CAPTURA_TIPO: HttpStatus.BAD_REQUEST,
  SOPORTE_CAPTURA_VACIA: HttpStatus.BAD_REQUEST,
  SOPORTE_CAPTURA_ILEGIBLE: HttpStatus.BAD_REQUEST,
  SOPORTE_CAPTURA_PESADA: HttpStatus.BAD_REQUEST,
  SOPORTE_CAPTURA_NO_CASA: HttpStatus.BAD_REQUEST,
  SOPORTE_NO_ENCONTRADO: HttpStatus.NOT_FOUND,
  SOPORTE_SIN_PERMISO: HttpStatus.FORBIDDEN,
};

/** Traduce los errores de dominio de mod.soporte a `{ statusCode, code, message }`. */
@Catch(SoporteError)
export class SoporteErrorFilter implements ExceptionFilter<SoporteError> {
  catch(exception: SoporteError, host: ArgumentsHost) {
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
