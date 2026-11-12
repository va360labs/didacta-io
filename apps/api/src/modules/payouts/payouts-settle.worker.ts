/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { SettleSweepResult } from '@didacta/mod-payouts';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PayoutsRuntime } from './payouts-runtime.service';

const QUEUE_NAME = 'didacta.payouts.settle';
/** Cada minuto. */
const PATTERN = process.env['PAYOUTS_SETTLE_CRON'] ?? '* * * * *';
/** Ventas por barrido: las más atrasadas primero. */
const BATCH = 100;

/**
 * Barrido de liquidación (BullMQ, patrón de
 * `subscriptions-grace-expiration.worker.ts`). La cola es la propia tabla de
 * ventas: cada minuto se avanzan las `AWAITING_FEE`, `READY` y `HELD` cuya
 * próxima consulta ya venció (`SettlementService.sweep`). La concurrencia con
 * el webhook la resuelve la liquidación (arriendo por venta), no la cola.
 *
 * Sin `REDIS_URL` no se programa: el webhook liquida en línea
 * (`PayoutsRuntime.settleInline`) y el conciliador recoge lo que quede. En
 * `NODE_ENV=test` tampoco.
 */
@Injectable()
export class PayoutsSettleWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL no seteada — sin barrido de liquidación: las ventas se liquidan en línea desde el webhook',
      );
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;
    this.queue = new Queue(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 100 },
        removeOnFail: { age: 7 * 24 * 3600, count: 100 },
      },
    });
    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        await this.sweep();
      },
      { connection: this.workerConnection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'payouts settle job falló');
    });
    // Repeat estable: reiniciar no duplica la programación.
    await this.queue.add(
      'sweep',
      {},
      { repeat: { pattern: PATTERN, tz: 'UTC' }, jobId: 'payouts-settle-sweep' },
    );
    this.logger.log(`barrido de liquidación activo ('${PATTERN}' UTC)`);
  }

  /** Un barrido. Público para el disparo manual y los tests. */
  async sweep(): Promise<SettleSweepResult> {
    const result = await this.runtime.settlement.sweep(BATCH);
    if (result.due > 0) {
      this.logger.log({ ...result }, 'payouts settle: barrido completado');
    }
    return result;
  }

  async onModuleDestroy(): Promise<void> {
    for (const close of [
      () => this.worker?.close(),
      () => this.queue?.close(),
      () => this.connection?.quit(),
      () => this.workerConnection?.quit(),
    ]) {
      try {
        await close();
      } catch {
        /* noop */
      }
    }
  }
}
