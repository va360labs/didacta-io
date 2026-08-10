/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ScimExceptionFilter — traduce CUALQUIER excepción que ocurra dentro de
 * `/scim/v2/**` a un error RFC 7644 §3.12 servido como `application/scim+json`.
 *
 * Por qué hace falta un filtro propio:
 *   El controller ya lanzaba errores SCIM bien formados, pero nunca llegaban
 *   así al IdP. En el camino se cruzan tres piezas globales que no saben nada
 *   de SCIM:
 *     - `HttpExceptionNormalizerFilter` (main.ts) añade `statusCode` y
 *       `message` al cuerpo → el error deja de ser RFC puro.
 *     - `LicenseExceptionFilter` (license-sdk) emite su propio shape para el
 *       402 de `feat:scim`.
 *     - `RateLimitInterceptor` emite el suyo para el 429.
 *   Y ninguna de las tres pone el content-type del estándar. Un IdP estricto
 *   parsea por contrato: si el content-type es `application/json` y el cuerpo
 *   trae campos que no reconoce, lo trata como respuesta opaca y reporta un
 *   error genérico al admin.
 *
 * Alcance y precedencia:
 *   Va montado con `@UseFilters` a nivel de CONTROLLER, no global. Nest ordena
 *   [globales…, clase…, método…] y luego invierte, así que un filtro de clase
 *   gana a los globales. `@Catch()` sin argumentos captura todo lo que pase por
 *   las rutas de este controller — incluidos guards (401 del ScimAuthGuard,
 *   402 del LicenseGuard), interceptores globales (429) y pipes (400 de Zod).
 *   Fuera de `/scim` no cambia nada: los filtros globales siguen mandando.
 */

import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { CapabilityRequiredError, LicenseSignatureError } from '@didacta/license-sdk';
import type { FastifyReply } from 'fastify';
import {
  SCIM_CONTENT_TYPE,
  SCIM_SCHEMAS,
  makeScimError,
  type ScimError,
  type ScimErrorType,
} from './scim.types';

/**
 * `scimType` por defecto cuando la excepción no trae uno propio.
 *
 * RFC 7644 §3.12 sólo define `scimType` para un subconjunto de errores. El
 * único que podemos deducir sin adivinar es el 400: si llegamos aquí con un
 * 400 sin `scimType`, viene del `ZodValidationPipe`, es decir "el cuerpo o los
 * query params no se ajustan al schema" → `invalidSyntax`.
 */
function defaultScimType(status: number): ScimErrorType | undefined {
  return status === HttpStatus.BAD_REQUEST ? 'invalidSyntax' : undefined;
}

/**
 * ¿La respuesta de la excepción YA es un error SCIM? El service y el guard
 * construyen los suyos con `makeScimError`, y en ese caso hay que respetarlos
 * tal cual (traen `scimType` calculado con contexto que aquí no tenemos:
 * `uniqueness`, `invalidFilter`, `invalidPath`…).
 */
function asScimError(response: unknown): ScimError | null {
  if (typeof response !== 'object' || response === null) return null;
  const candidate = response as Record<string, unknown>;
  const schemas = candidate['schemas'];
  if (!Array.isArray(schemas) || !schemas.includes(SCIM_SCHEMAS.ERROR)) return null;
  if (typeof candidate['detail'] !== 'string') return null;
  return candidate as unknown as ScimError;
}

/** Texto humano del error a partir del cuerpo de una HttpException. */
function extractDetail(exception: HttpException, response: unknown): string {
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null) {
    const message = (response as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
  }
  return exception.message || 'Error';
}

/**
 * Traduce una excepción cualquiera al par (status HTTP, cuerpo SCIM).
 * Exportada para poder testearla sin levantar la app.
 */
export function toScimErrorResponse(exception: unknown): { status: number; body: ScimError } {
  if (exception instanceof CapabilityRequiredError) {
    // El mensaje del SDK ya nombra la capability ("feat:scim"), que es
    // justo el dato que el admin necesita para saber qué le falta.
    return {
      status: HttpStatus.PAYMENT_REQUIRED,
      body: makeScimError(HttpStatus.PAYMENT_REQUIRED, exception.message),
    };
  }

  if (exception instanceof LicenseSignatureError) {
    return {
      status: HttpStatus.UNAUTHORIZED,
      body: makeScimError(HttpStatus.UNAUTHORIZED, exception.message),
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();

    const already = asScimError(response);
    if (already) {
      // Realineamos `status` con el HTTP real: es el único campo que puede
      // desincronizarse si alguien construye el cuerpo con un número y lanza
      // la excepción con otro.
      return { status, body: { ...already, status: String(status) } };
    }

    return {
      status,
      body: makeScimError(status, extractDetail(exception, response), defaultScimType(status)),
    };
  }

  // Errores no controlados: el IdP recibe un 500 SCIM sin el mensaje interno.
  // El detalle se queda en el log de la instancia (ver `catch`).
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: makeScimError(HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error.'),
  };
}

@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ScimExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const { status, body } = toScimErrorResponse(exception);

    // Los 500 los perdía el `BaseExceptionFilter` de Nest si no los
    // registramos aquí: este filtro es el último que ve la excepción.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled error in SCIM endpoint: ${
          exception instanceof Error ? exception.stack : String(exception)
        }`,
      );
    }

    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(status).header('content-type', SCIM_CONTENT_TYPE).send(body);
  }
}
