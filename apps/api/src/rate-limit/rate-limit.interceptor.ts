/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RateLimitInterceptor — sexto piloto License SDK.
 *
 * Aplicado global vía APP_INTERCEPTOR. Para cada request HTTP:
 *   1. Identifica `tenantId` desde `request.user` (lo setea JwtAuthGuard) o
 *      desde un header `x-tenant-id` ya resuelto por TenantMiddleware. Si no
 *      hay nada, trata la request como pública (bucket `'anonymous'`).
 *   2. Decide `isPublic`: si no hay JWT verificado, es pública.
 *   3. Llama `RateLimitService.recordRequest`.
 *   4. Setea SIEMPRE los headers estándar (`X-RateLimit-*`).
 *   5. Si la request fue rechazada, lanza `HttpException(429)` con
 *      `Retry-After` adicional.
 *
 * Por qué interceptor y no guard:
 *   El interceptor corre DESPUÉS de los guards (JwtAuthGuard ya pobló
 *   `request.user`) y tiene acceso al ExecutionContext + Response — necesario
 *   para escribir headers también en el camino feliz, no solo cuando
 *   rechazamos. Un guard se ejecuta antes y no sabe si la request va a 200,
 *   400, 500, etc.
 *
 * Endpoints exentos:
 *   Healthchecks (`/healthz`, `/readyz`, `/livez`), `/metrics` y la página
 *   de docs (`/api/docs*`) NO se rate-limitean — son load-balancer-facing y
 *   romperlos por rate limit nos sacaría de servicio en cualquier scrape.
 */

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, from, of, switchMap } from 'rxjs';
import { RateLimitService } from './rate-limit.service';
import type { RateLimitDecision } from './rate-limit.types';

/**
 * Path prefixes que NO pasan por el rate limiter. Coinciden con los excluidos
 * del global prefix en `main.ts` + el `/metrics` (que va por scraping).
 */
const RATE_LIMIT_EXEMPT_PREFIXES = [
  '/healthz',
  '/readyz',
  '/livez',
  '/metrics',
  '/api/docs',
  '/api/license', // estado público de la licencia — necesario para el frontend incluso bajo rate limit
];

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(private readonly rateLimit: RateLimitService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpCtx = context.switchToHttp();
    // Si la request no es HTTP (ej. RPC, websocket sin upgrade) no
    // interferimos. El interceptor está pensado para HTTP/REST.
    const requestType = context.getType();
    if (requestType !== 'http') {
      return next.handle();
    }

    const request = httpCtx.getRequest<FastifyRequest>();
    const reply = httpCtx.getResponse<FastifyReply>();
    const url = (request.url ?? '').split('?')[0] ?? '';

    if (RATE_LIMIT_EXEMPT_PREFIXES.some((p) => url.startsWith(p))) {
      return next.handle();
    }

    // `request.user` lo setea JwtAuthGuard cuando el endpoint pasa por él.
    // Para públicos (sin JwtAuthGuard) `request.user` queda undefined → el
    // bucket es público y `tenantId` es 'anonymous'.
    const user = request.user;
    const isPublic = !user;
    const tenantId = user?.tenantId ?? 'anonymous';

    return from(this.rateLimit.recordRequest(tenantId, isPublic)).pipe(
      switchMap((decision) => {
        this.applyHeaders(reply, decision);

        if (!decision.allowed) {
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              error: 'TooManyRequests',
              code: 'rate_limit_exceeded',
              message:
                `Has superado el límite de ${decision.limit} req/min para tu plan ` +
                `(${decision.tier}). Reintenta en ${decision.retryAfterSeconds ?? 60}s.`,
              capability: 'feat:api.rate_limit.elevated',
              tier: decision.tier,
              limit: decision.limit,
              retryAfterSeconds: decision.retryAfterSeconds ?? 60,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        return next.handle();
      }),
      // `of()` nunca se usa en el path actual — está acá únicamente como
      // marcador de que el operador `switchMap` necesita un Observable de
      // origen. No tocar sin entender el contrato de RxJS.
      switchMap((value) => of(value)),
    );
  }

  /**
   * Setea los headers estándar de rate limit. Soportamos tanto el shape
   * Fastify (`reply.header(...)`) como Express (`reply.setHeader(...)`)
   * por defensa, aunque la app corre en Fastify.
   */
  private applyHeaders(reply: FastifyReply, decision: RateLimitDecision): void {
    const setHeader = (name: string, value: string) => {
      const r = reply as unknown as {
        header?: (n: string, v: string) => void;
        setHeader?: (n: string, v: string) => void;
      };
      if (typeof r.header === 'function') {
        r.header(name, value);
      } else if (typeof r.setHeader === 'function') {
        r.setHeader(name, value);
      }
    };

    setHeader('X-RateLimit-Limit', String(decision.limit));
    setHeader('X-RateLimit-Remaining', String(decision.remaining));
    setHeader('X-RateLimit-Reset', String(Math.floor(decision.resetAt.getTime() / 1000)));
    setHeader('X-RateLimit-Tier', decision.tier);
    if (!decision.allowed && decision.retryAfterSeconds !== undefined) {
      setHeader('Retry-After', String(decision.retryAfterSeconds));
    }
  }
}
