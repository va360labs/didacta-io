/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Normaliza la shape de TODA HttpException a `{ statusCode, code?, message, … }`
 * (decisión D6 de i18n: el backend NO traduce — expone un `code` estable y el
 * frontend resuelve la traducción; `message` queda en español como fallback).
 *
 * CONVENCIÓN DE CODES (para todo code nuevo):
 *   - `SCREAMING_SNAKE` con prefijo de área: `AUTH_`, `ADMIN_`, `SSO_`,
 *     `SETUP_`, `ENROLLMENT_`, `MOD_<SLUG>_`…
 *   - Se declara en el segundo argumento del body:
 *       `throw new BadRequestException({ message: 'texto es-ES', code: 'AUTH_X' })`
 *   - Los codes YA vivos en el front NO se renombran (son contrato — ver
 *     apps/web/src/lib/api-client.ts): `mfa_required`, `AMBIGUOUS_TENANT`,
 *     `session_revoked`, `account_deleted`, `account_suspended`,
 *     `user_restricted`, `rate_limit_exceeded`, etc.
 *
 * Este filter NO pisa a los filters de dominio de los módulos (los 21
 * `@Catch(XError)` vía APP_FILTER) ni al LicenseExceptionFilter: esos cazan
 * clases propias, no `HttpException`, y ya emiten `code`.
 */

import { ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

interface NormalizedErrorBody {
  statusCode: number;
  message: string;
  code?: string;
  [extra: string]: unknown;
}

/** Extrae un body normalizado de la respuesta interna de la excepción. */
export function normalizeHttpExceptionBody(exception: HttpException): NormalizedErrorBody {
  const status = exception.getStatus();
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return { statusCode: status, message: response };
  }

  // Nest mete el texto en `message`; los throws con body objeto pueden traer
  // `code` y campos extra (issues de Zod, reasons, capability…): se preservan.
  // `code` se separa del spread para que un valor no-string nunca se cuele.
  const { code, ...raw } = response as Record<string, unknown>;
  const message =
    typeof raw['message'] === 'string'
      ? raw['message']
      : Array.isArray(raw['message'])
        ? (raw['message'] as unknown[]).join('; ')
        : (exception.message ?? 'Error');

  return {
    ...raw,
    statusCode: status,
    message,
    ...(typeof code === 'string' ? { code } : {}),
  };
}

@Catch(HttpException)
export class HttpExceptionNormalizerFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost) {
    const body = normalizeHttpExceptionBody(exception);
    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply.status(body.statusCode).send(body);
      return;
    }
    throw exception;
  }
}
