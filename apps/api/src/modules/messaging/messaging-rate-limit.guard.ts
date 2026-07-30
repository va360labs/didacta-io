import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import IORedis, { type Redis } from 'ioredis';

/**
 * Cupo de peticiones de mensajería (ADR-019 §3).
 *
 * La API no tiene throttler global: el rate limit de envío que prometía el PRD
 * de `mensajes` (20 msg/min) nunca se implementó. Abrir `/typing` —que el
 * cliente llama cada 3 s mientras se teclea— sin cupo sería regalar
 * amplificación, así que el guard cubre AMBOS endpoints.
 *
 * Ventana fija por (bucket, tenant, usuario): `INCR` + `EXPIRE` en la primera
 * petición de la ventana. Con Redis caído o ausente (dev) degrada a un contador
 * en memoria del proceso — peor reparto entre instancias, pero nunca deja de
 * proteger ni tumba la petición.
 */

export const MESSAGING_RATE_LIMIT_KEY = 'messaging:rateLimit';

export interface MessagingRateLimitOptions {
  /** Nombre corto del cupo; separa contadores entre endpoints. */
  bucket: string;
  /** Peticiones permitidas dentro de la ventana. */
  limit: number;
  /** Duración de la ventana en segundos. */
  windowSec: number;
}

export const MessagingRateLimit = (options: MessagingRateLimitOptions) =>
  SetMetadata(MESSAGING_RATE_LIMIT_KEY, options);

/** Código estable para que el frontend humanice el 429. */
export const MESSAGING_RATE_LIMITED = 'MESSAGING_RATE_LIMITED';

interface LocalCounter {
  count: number;
  resetAt: number;
}

@Injectable()
export class MessagingRateLimitGuard implements CanActivate, OnModuleInit, OnApplicationShutdown {
  private client: Redis | null = null;
  private readonly local = new Map<string, LocalCounter>();
  private lastPruneAt = 0;

  constructor(@Optional() private readonly reflector?: Reflector) {}

  onModuleInit(): void {
    const url = process.env['REDIS_URL'];
    if (url && process.env['NODE_ENV'] !== 'test') {
      const client = new IORedis(url, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      client.on('error', () => {
        /* swallow — el guard degrada al contador local */
      });
      this.client = client;
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector?.getAllAndOverride<MessagingRateLimitOptions | undefined>(
      MESSAGING_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Sin decorador no hay cupo: el guard puede colgarse del controller entero
    // sin afectar a los endpoints que no lo declaran.
    if (!options) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = request.user;
    // Sin identidad resuelta, el cupo no es aplicable: quien decide es JwtAuthGuard.
    if (!user) return true;

    const key = `didacta:rl:msg:${options.bucket}:${user.tenantId}:${user.sub}`;
    const count = await this.hit(key, options.windowSec);
    if (count > options.limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: MESSAGING_RATE_LIMITED,
          message: 'Vas demasiado rápido. Espera unos segundos y vuelve a intentarlo.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /** Incrementa el contador de la ventana y devuelve el valor resultante. */
  private async hit(key: string, windowSec: number): Promise<number> {
    if (this.client && this.client.status === 'ready') {
      try {
        const count = await this.client.incr(key);
        // Solo la primera petición de la ventana fija el TTL: refrescarlo en
        // cada hit convertiría la ventana fija en una ventana deslizante que
        // nunca expira mientras el usuario siga pulsando.
        if (count === 1) await this.client.expire(key, windowSec);
        return count;
      } catch {
        /* cae al contador local */
      }
    }
    return this.hitLocal(key, windowSec);
  }

  private hitLocal(key: string, windowSec: number): number {
    const now = Date.now();
    this.pruneLocal(now);
    const current = this.local.get(key);
    if (!current || current.resetAt <= now) {
      this.local.set(key, { count: 1, resetAt: now + windowSec * 1_000 });
      return 1;
    }
    current.count += 1;
    return current.count;
  }

  /** Barrido perezoso: sin él el mapa crece con cada usuario que pasa por aquí. */
  private pruneLocal(now: number): void {
    if (now - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now;
    for (const [key, counter] of this.local) {
      if (counter.resetAt <= now) this.local.delete(key);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.local.clear();
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        /* el proceso ya está bajando */
      }
      this.client = null;
    }
  }
}
