/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  type CallHandler,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { blockedBy } from './restriction-scopes';
import { RestrictionService } from './restriction.service';

/** Barato y primero: el 90 % del tráfico es GET y ni siquiera mira la caché. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Interceptor global que corta las peticiones con las que un usuario
 * sancionado intentaría aportar contenido.
 *
 * Va como Interceptor y no como Guard por la misma razón que
 * `ModuleAccessInterceptor`: necesita `request.user`, que se popula en los
 * guards de controller, y un APP_GUARD global corre ANTES que esos guards.
 *
 * Que sea global es justo el punto: cubre de una vez los 119 `@UseGuards` del
 * proyecto, incluidos los que NO pasan por `JwtAuthGuard` —
 * `community-api.controller.ts` usa `JwtOrApiKeyGuard` y publica posts reales
 * en el feed. Con el enforcement repartido por módulo, esa ruta se habría
 * quedado fuera.
 *
 * Efecto lateral buscado: ningún módulo conoce esta lógica ni cambia por ella.
 */
@Injectable()
export class RestrictionInterceptor implements NestInterceptor {
  constructor(private readonly restrictions: RestrictionService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (!MUTATING.has(method)) return next.handle();

    const user = request.user;
    // Sin user es una ruta pública: el guard ya habrá rechazado si tocaba.
    if (!user?.tenantId || !user.sub) return next.handle();

    const active = await this.restrictions.activeRestrictions(user.tenantId, user.sub);
    if (active.length === 0) return next.handle();

    const url = request.url ?? '';
    for (const restriction of active) {
      const area = blockedBy(restriction.scopes, method, url);
      if (!area) continue;

      throw new ForbiddenException({
        code: 'user_restricted',
        message: this.buildMessage(area, restriction.reason, restriction.expiresAt),
        area,
        reason: restriction.reason,
        expiresAt: restriction.expiresAt,
      });
    }

    return next.handle();
  }

  /**
   * Un 403 mudo genera un ticket de soporte; uno que explica el motivo y la
   * fecha de fin, no. Por eso el motivo es obligatorio al sancionar.
   */
  private buildMessage(area: string, reason: string, expiresAt: string | null): string {
    const hasta = expiresAt
      ? `hasta el ${new Date(expiresAt).toLocaleString('es-ES', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : 'de forma permanente';
    return `Un administrador ha restringido tu acceso a ${area.toLowerCase()} ${hasta}. Motivo: ${reason}`;
  }
}
