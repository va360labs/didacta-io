/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ScimContentTypeInterceptor — pone `application/scim+json` en las respuestas
 * correctas de `/scim/v2/**`.
 *
 * El camino de error lo cubre `ScimExceptionFilter`, que no pasa por aquí (un
 * filtro escribe la respuesta él mismo). Este interceptor cubre el otro medio:
 * sin él, `/scim` respondería el estándar en los errores y `application/json`
 * en los 200, que es un contrato incoherente para un IdP que valida el
 * content-type de todo lo que recibe (RFC 7644 §3.1).
 *
 * El 204 de `DELETE /Users/:id` se deja sin content-type a propósito: no lleva
 * cuerpo, y anunciar un tipo de medio para un cuerpo vacío confunde a los
 * clientes que lo intentan parsear.
 */

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Observable, tap } from 'rxjs';
import { SCIM_CONTENT_TYPE } from './scim.types';

@Injectable()
export class ScimContentTypeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const reply = context.switchToHttp().getResponse<FastifyReply>();

    return next.handle().pipe(
      tap((payload) => {
        if (payload === null || payload === undefined) return;
        reply.header('content-type', SCIM_CONTENT_TYPE);
      }),
    );
  }
}
