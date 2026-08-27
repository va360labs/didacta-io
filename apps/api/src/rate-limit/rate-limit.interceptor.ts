/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RateLimitInterceptor — sexto piloto License SDK.
 *
 * Aplicado global vía APP_INTERCEPTOR. Para cada request HTTP:
 *   1. Identifica `tenantId` desde `request.user` (lo setea JwtAuthGuard) o
 *      desde `request.scimTenantId` (lo setea ScimAuthGuard con el Bearer del
 *      IdP). Si no hay ninguno, trata la request como pública y deriva el
 *      cubo de la IP canónica del cliente (ver `anonymousIdentifier`).
 *   2. Decide `isPublic`: si no hay ninguna identidad resuelta, es pública.
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
import { createHash } from 'node:crypto';
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

/**
 * Sal del hash de IP. `AUTH_SECRET` ya es un secreto por instancia, así que
 * dos despliegues no producen las mismas claves y nadie que vea Redis puede
 * revertir el hash por fuerza bruta sobre el espacio IPv4.
 */
function ipHashSalt(): string {
  return process.env['AUTH_SECRET'] ?? 'didacta-rate-limit';
}

/**
 * Reduce una IPv6 a su prefijo /64. Un cliente doméstico con IPv6 tiene una
 * /64 entera para él: limitar por dirección exacta sería regalar miles de
 * cubos a la misma persona. En IPv4 se usa la dirección completa.
 */
function normalizeIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  // `::ffff:1.2.3.4` — IPv4 mapeada, se trata como IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  const groups = ip.split(':');
  return groups.slice(0, 4).join(':') + '::/64';
}

/**
 * Identificador de cubo para tráfico sin identidad resuelta.
 *
 * Antes, TODA request pública compartía la clave literal `'anonymous'`: con
 * Redis activo, los 30 req/min por defecto del plan Community eran un único
 * cubo global para la instancia entera, así que un solo cliente podía dejar el
 * catálogo y el acceso en 429 para visitantes que no tenían nada que ver.
 * Ahora la clave sale de la IP canónica del cliente.
 *
 * `request.ip` lo resuelve Fastify a partir de `trustProxy`, que en `main.ts`
 * declara CUÁNTOS saltos de proxy propios hay. Eso importa: con `trustProxy:
 * true` cualquiera podía mandar un `X-Forwarded-For` inventado y elegir el
 * cubo que le apeteciera — el suyo para saltarse el límite, o el de otro para
 * dejarlo fuera.
 *
 * La IP se guarda hasheada: la clave vive 65 segundos en Redis, pero no hay
 * razón para dejar direcciones en claro.
 *
 * Reportado por Bruno (ingenierosindustriales.com), ver SECURITY-CREDITS.md.
 */
function anonymousIdentifier(request: FastifyRequest): string {
  const ip = typeof request.ip === 'string' ? request.ip.trim() : '';
  // Sin IP (transporte no-TCP, tests) volvemos al cubo compartido: es el
  // comportamiento anterior y sigue siendo mejor que no limitar nada.
  if (!ip) return 'anonymous';
  const digest = createHash('sha256')
    .update(ipHashSalt())
    .update(':')
    .update(normalizeIp(ip))
    .digest('hex')
    .slice(0, 16);
  return `anon:${digest}`;
}

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

    // Identidad de la request, en orden de confianza:
    //
    //   1. `request.user` — lo setea JwtAuthGuard con los claims del JWT.
    //   2. `request.scimTenantId` — lo setea ScimAuthGuard tras validar el
    //      Bearer estático del IdP. Es una identidad DISTINTA del JWT (por eso
    //      no comparten campo: son trust boundaries separados) pero identifica
    //      un tenant igual de bien, y contarla como tráfico anónimo metía a
    //      todos los IdPs de la instancia en el mismo bucket `'anonymous'` que
    //      el tráfico sin autenticar de internet. Un sync inicial se comía los
    //      429 del cupo público por culpa de visitantes que no tienen nada que
    //      ver con el tenant.
    //
    // Sin ninguna de las dos, la request es pública y el bucket se deriva de
    // la IP del cliente (ver `anonymousIdentifier`).
    const user = request.user;
    const identifiedTenantId = user?.tenantId ?? request.scimTenantId;
    const isPublic = identifiedTenantId === undefined;
    const identifier = identifiedTenantId ?? anonymousIdentifier(request);

    return from(this.rateLimit.recordRequest(identifier, isPublic)).pipe(
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
