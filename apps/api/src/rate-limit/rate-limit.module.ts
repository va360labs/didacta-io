/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RateLimitModule — sexto piloto License SDK.
 *
 * Registra:
 *   - RateLimitService (singleton).
 *   - RateLimitInfoController (`GET /admin/rate-limit/info`).
 *   - APP_INTERCEPTOR global → RateLimitInterceptor.
 *
 * El cliente Redis se inyecta vía un factory provider que:
 *   - Si `REDIS_URL` está set y no estamos en `NODE_ENV=test` → crea una
 *     conexión IORedis dedicada.
 *   - En test/local sin REDIS_URL → inyecta `null` (el service entra en
 *     failsafe open).
 *
 * Esto se alinea con el patrón existente de OutboxQueueService.
 */

import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import IORedis, { type Redis } from 'ioredis';
import { AuthModule } from '../auth/auth.module';
import { RateLimitInfoController } from './rate-limit-info.controller';
import { RateLimitInterceptor } from './rate-limit.interceptor';
import {
  RATE_LIMIT_REDIS_TOKEN,
  RateLimitService,
  type RateLimitRedisClient,
} from './rate-limit.service';

/**
 * Wrapper opcional que cierra la conexión Redis cuando la app se apaga.
 * Vive dentro del módulo para no exponer el cliente a otros módulos.
 */
class RateLimitRedisLifecycle implements OnApplicationShutdown {
  constructor(private readonly client: Redis | null) {}
  async onApplicationShutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // ignore — el proceso ya está bajando.
      }
    }
  }
}

const redisProvider: FactoryProvider<RateLimitRedisClient | null> = {
  provide: RATE_LIMIT_REDIS_TOKEN,
  useFactory: (): RateLimitRedisClient | null => {
    const url = process.env['REDIS_URL'];
    if (!url) return null;
    if (process.env['NODE_ENV'] === 'test') return null;
    // Conexión dedicada — no la mezclamos con BullMQ porque BullMQ usa
    // comandos blocking (BRPOPLPUSH, etc.) y mezclar tira las latencias del
    // INCR del rate limiter. Misma estrategia que OutboxQueueService.
    const client = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      // Si Redis está down al boot, no rompemos: el service detecta el
      // error en runtime y entra en failsafe.
      lazyConnect: false,
    });
    // Evitamos que un error no-handleado tumbe el proceso. El service
    // captura los errores del INCR/EXPIRE explícitamente.
    client.on('error', () => {
      /* swallow — handled at call site */
    });
    return client as unknown as RateLimitRedisClient;
  },
};

@Module({
  // RateLimitInfoController usa @UseGuards(JwtAuthGuard). El guard inyecta
  // TokenService, que solo es resoluble si AuthModule está en imports del
  // módulo que registra el controller. Sin esto NestJS lanza al boot:
  //   "Nest can't resolve dependencies of the JwtAuthGuard (?, Reflector).
  //    TokenService is available in the RateLimitModule context"
  // Bug latente desde el 6º piloto — solo se manifestó al cambiar el orden
  // de instanciación tras añadir WebhooksModule (PR #35). Patrón estándar:
  // todo módulo cuyos controllers usan JwtAuthGuard DEBE importar AuthModule.
  imports: [AuthModule],
  controllers: [RateLimitInfoController],
  providers: [
    redisProvider,
    {
      provide: RateLimitRedisLifecycle,
      useFactory: (client: RateLimitRedisClient | null) =>
        new RateLimitRedisLifecycle(client as unknown as Redis | null),
      inject: [RATE_LIMIT_REDIS_TOKEN],
    },
    RateLimitService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RateLimitInterceptor,
    },
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {
  static forRoot(): DynamicModule {
    return {
      module: RateLimitModule,
    };
  }
}
