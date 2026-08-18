/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Enterprise
 *
 * This file is part of Didacta Enterprise Edition and is licensed under the
 * Didacta Enterprise License (LICENSE_EE). It cannot be used in production
 * without a valid Didacta Enterprise license key. See LICENSE_EE for details.
 *
 * WebhooksDispatcherEE — path Enterprise del 10º piloto License SDK.
 *
 *   - Cola dedicada BullMQ `didacta.webhooks.outbound`.
 *   - Reintentos exponenciales con backoff escalonado:
 *       attempt 1 → inmediato
 *       attempt 2 → +30s
 *       attempt 3 → +2min
 *       attempt 4 → +8min
 *       attempt 5 → +30min
 *       attempt 6 → +2h (último)
 *     (Total 5 reintentos sobre el primer intento; ver `attempts: 6`).
 *   - Firma HMAC-SHA256 con header `X-Didacta-Signature: sha256=<hex>`.
 *   - Tras agotar reintentos, persiste en `webhook_dead_letter` para que
 *     el admin pueda reintentar manualmente desde la UI.
 *   - Métricas Prometheus (latencia, success/failure, queue depth).
 *
 * Inyección: implementa el contrato `WebhooksEEDispatcher` declarado en
 * webhooks.types.ts. El community service lo recibe vía
 * `WEBHOOKS_EE_DISPATCHER_TOKEN`. Esto permite que el archivo CE NO
 * `import` estático de este `.ee.ts` (convención open-core).
 */

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { createHmac } from 'node:crypto';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import { WebhooksMetricsEE } from './webhooks.metrics.ee';
import type { WebhookEnvelope, WebhooksEEDispatcher } from './webhooks.types';

const QUEUE_NAME = 'didacta.webhooks.outbound';

interface OutboundJobData {
  tenantId: string;
  endpointId: string;
  url: string;
  secret: string;
  eventType: string;
  payload: unknown;
  /**
   * Sobre resuelto por el service (identidad del alumno incluida). Opcional
   * porque un job encolado por una version anterior sigue en Redis cuando se
   * despliega esta: sin el, `deliver` reconstruye lo que puede.
   */
  envelope?: WebhookEnvelope;
}

/**
 * Backoff escalonado en ms. BullMQ por defecto usa exponencial con base
 * fija; lo sustituimos por una función que mapea attempt → delay para
 * cumplir el spec (30s/2m/8m/30m/2h).
 */
const RETRY_DELAYS_MS: number[] = [
  30_000, // 30s
  120_000, // 2m
  480_000, // 8m
  1_800_000, // 30m
  7_200_000, // 2h
];
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length; // primer intento + 5 reintentos = 6

/**
 * Devuelve el delay para el reintento `n` (n=1 es el primer reintento, no
 * el intento inicial). BullMQ pasa `attemptsMade` que ya cuenta los previos.
 */
function nextDelayMs(attemptsMade: number): number {
  const idx = attemptsMade - 1;
  if (idx < 0 || idx >= RETRY_DELAYS_MS.length) return 60_000;
  return RETRY_DELAYS_MS[idx] ?? 60_000;
}

/**
 * Computa la firma HMAC-SHA256 del cuerpo del request.
 * Output: `sha256=<hex>` — formato estándar en GitHub/Stripe webhooks.
 */
export function signWebhookBody(secret: string, body: string): string {
  const hex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${hex}`;
}

@Injectable()
export class WebhooksDispatcherEE
  implements WebhooksEEDispatcher, OnApplicationBootstrap, OnModuleDestroy
{
  private queue?: Queue<OutboundJobData>;
  private worker?: Worker<OutboundJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly metrics: WebhooksMetricsEE,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn(
        'WebhooksDispatcherEE: REDIS_URL ausente — el dispatcher EE no se inicializa.',
      );
      return;
    }
    if (process.env['NODE_ENV'] === 'test') {
      // En tests no levantamos BullMQ — los unit tests inyectan un fake
      // dispatcher mediante el token DI.
      return;
    }

    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    const conn: ConnectionOptions = this.connection;
    this.queue = new Queue<OutboundJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        // BullMQ no permite array de delays nativo: usamos `backoff` con
        // type 'custom' y `customBackoffStrategies` definido al crear el
        // worker. La función nextDelayMs() devuelve el delay correcto.
        backoff: { type: 'didacta-webhooks', delay: 0 },
        removeOnComplete: { age: 24 * 3600, count: 5_000 },
        removeOnFail: { age: 30 * 24 * 3600, count: 50_000 },
      },
    });

    this.worker = new Worker<OutboundJobData>(
      QUEUE_NAME,
      async (job) => {
        await this.deliver(job.data, job.attemptsMade + 1);
      },
      {
        connection: this.workerConnection,
        concurrency: 10,
        settings: {
          backoffStrategy: (attemptsMade: number) => nextDelayMs(attemptsMade),
        },
      },
    );

    this.worker.on('failed', async (job, err) => {
      if (!job) return;
      this.metrics.recordDelivery('failure', job.data.tenantId);
      // ¿Es la última tentativa? → escribimos dead-letter.
      if (job.attemptsMade >= MAX_ATTEMPTS) {
        await this.persistDeadLetter(job.data, err.message, job.attemptsMade);
        this.metrics.recordDeadLetter(job.data.tenantId);
      }
    });
    this.worker.on('completed', (job) => {
      this.metrics.recordDelivery('success', job.data.tenantId);
      this.metrics.recordAttempts(job.attemptsMade + 1);
    });

    // Refresco periódico de queue depth para Prometheus.
    setInterval(() => {
      void this.refreshQueueDepth();
    }, 10_000).unref();

    this.logger.log('WebhooksDispatcherEE activo (BullMQ + Redis)');
  }

  /**
   * Encola un job de entrega. El community service llama esto vía el
   * contrato `WebhooksEEDispatcher`.
   *
   * Si la cola NO está inicializada (REDIS_URL ausente, test mode),
   * lanza — el caller (community service) tiene fallback al path naive.
   */
  async dispatch(input: OutboundJobData): Promise<void> {
    if (!this.queue) {
      throw new Error('WebhooksDispatcherEE no inicializado (REDIS_URL ausente)');
    }
    await this.queue.add('deliver', input, {
      // jobId con timestamp evita colisión: si dos eventos del mismo type
      // llegan al mismo endpoint en la misma ms, BullMQ los dedupea.
      jobId: `${input.endpointId}:${input.eventType}:${Date.now()}`,
    });
  }

  /**
   * POST al endpoint con firma HMAC. Lanza error si falla (BullMQ aplica
   * backoff). Mide duración SIEMPRE (success o failure) para histograma.
   */
  private async deliver(data: OutboundJobData, attempt: number): Promise<void> {
    const start = process.hrtime.bigint();
    // El sobre manda; sin el (job viejo en la cola) se reconstruye el minimo
    // para no romper la entrega, aunque vaya sin identidad ni fecha real.
    const envelope: WebhookEnvelope = data.envelope ?? {
      event: data.eventType,
      data: data.payload,
      occurredAt: new Date().toISOString(),
      tenantId: data.tenantId,
      deliveryId: `${data.endpointId}-legacy`,
      learner: null,
    };
    const body = JSON.stringify({ ...envelope, attempt });
    const signature = signWebhookBody(data.secret, body);

    const controller = new AbortController();
    const timeoutMs = Number.parseInt(process.env['WEBHOOKS_TIMEOUT_MS'] ?? '5000', 10);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(data.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Didacta-Event': data.eventType,
          'X-Didacta-Signature': signature,
          // Estable entre reintentos: el numero de intento va aparte, para que
          // el receptor pueda deduplicar por esta cabecera.
          'X-Didacta-Delivery': envelope.deliveryId,
          'X-Didacta-Attempt': String(attempt),
          'X-Didacta-Tenant': data.tenantId,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.recordDuration(elapsed);

      if (!res.ok) {
        // Fail con HTTP error → BullMQ aplica retry.
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      clearTimeout(timer);
      const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.recordDuration(elapsed);
      this.logger.warn(
        {
          endpointId: data.endpointId,
          tenantId: data.tenantId,
          eventType: data.eventType,
          attempt,
          err: (err as Error).message,
        },
        'webhook delivery falló — BullMQ aplicará reintento si quedan',
      );
      throw err;
    }
  }

  /**
   * Persiste el evento en `webhook_dead_letter` cuando todos los reintentos
   * fueron agotados. Idempotencia: si ya existe una row para el mismo
   * (tenantId, endpointId, eventType, payload, createdAt-ish), creamos una
   * nueva igualmente — preferimos múltiples filas en histórico antes que
   * perder un fallo.
   */
  private async persistDeadLetter(
    data: OutboundJobData,
    lastError: string,
    attempts: number,
  ): Promise<void> {
    try {
      // La entrega trae su tenant: la escritura corre bajo su contexto para
      // que la extensión RLS la escope (F2).
      await runAsTenant(data.tenantId, () =>
        this.prisma.webhookDeadLetter.create({
          data: {
            tenantId: data.tenantId,
            endpointId: data.endpointId,
            eventType: data.eventType,
            payload: data.payload as never,
            lastError: lastError.slice(0, 4000),
            attempts,
          },
        }),
      );
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message, endpointId: data.endpointId },
        'WebhooksDispatcherEE: falló persistir dead-letter',
      );
    }
  }

  private async refreshQueueDepth(): Promise<void> {
    if (!this.queue) return;
    try {
      const counts = await this.queue.getJobCounts('wait', 'active', 'delayed', 'failed');
      const depth = (counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
      this.metrics.setQueueDepth(depth);
    } catch (err) {
      // Sin telemetría es preferible no bloquear.
      this.logger.debug({ err: (err as Error).message }, 'queue depth refresh falló');
    }
  }

  isEnabled(): boolean {
    return this.queue !== undefined;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker?.close();
    } catch {
      /* noop */
    }
    try {
      await this.queue?.close();
    } catch {
      /* noop */
    }
    try {
      await this.connection?.quit();
    } catch {
      /* noop */
    }
    try {
      await this.workerConnection?.quit();
    } catch {
      /* noop */
    }
  }
}
