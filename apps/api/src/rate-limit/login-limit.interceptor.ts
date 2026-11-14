/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Interceptor global del limitador del ACCESO. Solo actúa en las rutas
 * marcadas con `@LoginRateLimit(kind)`; el resto pasa sin tocar Redis.
 *
 * Global (APP_INTERCEPTOR, en `RateLimitModule`) y no `@UseInterceptors` en
 * cada controller: así usa la misma conexión Redis que el cupo general sin
 * que `AuthModule` tenga que importar `RateLimitModule` (que ya importa
 * `AuthModule`: sería circular).
 */

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, catchError, from, switchMap, tap, throwError } from 'rxjs';
import { resolvePublicHost } from '../common/resolve-public-host';
import { clientIpKey, saltedDigest } from './client-ip';
import { LoginLimitService, type LoginAttemptKeys } from './login-limit.service';
import {
  LOGIN_LIMIT_POLICIES,
  LOGIN_RATE_LIMITED_CODE,
  type LoginLimitKind,
  type LoginLimitPolicy,
} from './login-limit.types';

export const LOGIN_LIMIT_KEY = 'didacta:login-limit';

/** Marca una ruta del acceso para el limitador por IP y por cuenta. */
export const LoginRateLimit = (kind: LoginLimitKind) => SetMetadata(LOGIN_LIMIT_KEY, kind);

/** El correo tal como se compara: sin espacios y en minúsculas. */
export function normalizeLoginEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length > 0 && email.length <= 320 ? email : null;
}

/**
 * Clave de la cuenta del intento. El correo va con el dominio por el que se
 * entra: la misma persona puede estar en dos aulas, y bloquear su acceso a
 * una no debe bloquearlo en la otra. Hasheado: ni correos ni IP en claro en
 * Redis.
 */
export function loginAccountKey(
  policy: LoginLimitPolicy,
  request: Pick<FastifyRequest, 'body' | 'user' | 'headers' | 'hostname'>,
): string | null {
  if (policy.account === 'user') {
    const sub = request.user?.sub;
    return typeof sub === 'string' && sub ? `user:${sub}` : null;
  }
  if (policy.account === 'email') {
    const body = request.body as Record<string, unknown> | null | undefined;
    const email = normalizeLoginEmail(body?.['email']);
    if (!email) return null;
    // Sin puerto: el mismo aula llega como `aula.ejemplo.com` por el proxy y
    // como `aula.ejemplo.com:3000` en un salto interno; es la misma cuenta.
    const host = (resolvePublicHost(request as FastifyRequest) ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    return `email:${saltedDigest(`${host}|${email}`)}`;
  }
  return null;
}

/** Cuerpo del 429: el mismo exista o no la cuenta, y traducible por `code`. */
export function loginRateLimitedBody(retryAfterSeconds: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return {
    statusCode: HttpStatus.TOO_MANY_REQUESTS,
    error: 'TooManyRequests',
    code: LOGIN_RATE_LIMITED_CODE,
    message: `Demasiados intentos. Por seguridad, espera ${minutes} min y vuelve a probar.`,
    params: { minutes: String(minutes) },
    retryAfterSeconds,
  };
}

@Injectable()
export class LoginLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: LoginLimitService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const kind = this.reflector.get<LoginLimitKind | undefined>(
      LOGIN_LIMIT_KEY,
      context.getHandler(),
    );
    if (!kind) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const policy = LOGIN_LIMIT_POLICIES[kind];
    const keys: LoginAttemptKeys = {
      ip: clientIpKey(request.ip),
      account: loginAccountKey(policy, request),
    };

    return from(this.limiter.begin(keys)).pipe(
      switchMap((check) => {
        if (!check.allowed) {
          reply.header('Retry-After', String(check.retryAfterSeconds));
          throw new HttpException(
            loginRateLimitedBody(check.retryAfterSeconds),
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        // El handler emite un único valor: con él, el intento salió bien. Se
        // descuenta en el primero (una vez), sin esperar al `complete`.
        let settled = false;
        const settleOnce = () => {
          if (settled) return;
          settled = true;
          void this.limiter.settle(keys, check.counted, policy, 'success');
        };
        return next.handle().pipe(
          tap({ next: settleOnce, complete: settleOnce }),
          catchError((err: unknown) => {
            // Un 4xx es un intento fallido y se queda contado. Un fallo del
            // servidor no es culpa de quien intenta entrar: se descuenta.
            const status = err instanceof HttpException ? err.getStatus() : 500;
            if (status >= 500)
              void this.limiter.settle(keys, check.counted, policy, 'server-error');
            return throwError(() => err);
          }),
        );
      }),
    );
  }
}
