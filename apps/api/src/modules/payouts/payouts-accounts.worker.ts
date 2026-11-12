/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { PayoutsRuntime } from './payouts-runtime.service';

const QUEUE_NAME = 'didacta.payouts.accounts';
/** Cuentas que aún no pueden vender: cada 15 minutos. */
const PENDING_PATTERN = process.env['PAYOUTS_ACCOUNTS_PENDING_CRON'] ?? '*/15 * * * *';
/** Cuentas listas: una vez al día (de madrugada, UTC). */
const READY_PATTERN = process.env['PAYOUTS_ACCOUNTS_READY_CRON'] ?? '20 3 * * *';

export type PayoutsAccountsJobData = { readonly ready: boolean };

export interface PayoutsAccountsSweepResult {
  readonly accounts: number;
  readonly synced: number;
  readonly failed: number;
  readonly schedulesApplied: number;
}

/**
 * Conciliador de cuentas conectadas (BullMQ, patrón de
 * `subscriptions-grace-expiration.worker.ts`).
 *
 *  - Cada 15 min, las cuentas vivas que NO están READY: el creador puede haber
 *    terminado el alta sin volver a la pantalla, o Stripe haber acabado de
 *    revisarla. Además reintenta el calendario de pagos si no se pudo fijar.
 *  - Cada día, las READY: una restricción de Stripe tiene que acabar cortando
 *    ventas aunque se pierda el evento.
 *
 * Igual que el webhook, NO fija estados: llama a `syncAccount`, que consulta
 * Stripe. Sin `REDIS_URL` no se programa (y en `NODE_ENV=test` tampoco); el
 * estado se refresca entonces en la vuelta del alta (`GET status?sync=1`) y
 * con los eventos de cuenta.
 */
@Injectable()
export class PayoutsAccountsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<PayoutsAccountsJobData>;
  private worker?: Worker<PayoutsAccountsJobData>;
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
        'REDIS_URL no seteada — el conciliador de cuentas de cobro no se programa; el estado se refresca en la vuelta del alta',
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

    this.queue = new Queue<PayoutsAccountsJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 50 },
        removeOnFail: { age: 30 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker<PayoutsAccountsJobData>(
      QUEUE_NAME,
      async (job) => {
        await this.sweep({ ready: job.data.ready === true });
      },
      { connection: this.workerConnection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'payouts accounts job falló');
    });

    // Repeat estable: reiniciar no duplica la programación.
    await this.queue.add(
      'pending',
      { ready: false },
      { repeat: { pattern: PENDING_PATTERN, tz: 'UTC' }, jobId: 'payouts-accounts-pending' },
    );
    await this.queue.add(
      'ready',
      { ready: true },
      { repeat: { pattern: READY_PATTERN, tz: 'UTC' }, jobId: 'payouts-accounts-ready' },
    );
    this.logger.log(
      `conciliador de cuentas de cobro activo (pendientes '${PENDING_PATTERN}', listas '${READY_PATTERN}' UTC)`,
    );
  }

  /**
   * Un barrido. Público para el disparo manual y los tests. Un fallo con una
   * cuenta no para el resto; si falló alguna, se relanza al final para que
   * BullMQ lo reintente.
   */
  async sweep(data: PayoutsAccountsJobData): Promise<PayoutsAccountsSweepResult> {
    const accounts = await this.runtime.accounts.listAccountsToSync({ ready: data.ready });
    let synced = 0;
    let failed = 0;
    let schedulesApplied = 0;
    for (const account of accounts) {
      try {
        await runAsTenant(
          account.tenantId,
          async () => {
            if (!account.hasSchedule) {
              await this.runtime.accounts.applyPayoutSchedule(account.tenantId);
              schedulesApplied += 1;
            }
            await this.runtime.accounts.syncAccount(account.tenantId, account.stripeAccountId);
          },
          { traceLabel: 'payouts-accounts' },
        );
        synced += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          {
            tenantId: account.tenantId,
            stripeAccountId: account.stripeAccountId,
            err: err instanceof Error ? err.message : String(err),
          },
          'payouts accounts: no se pudo sincronizar una cuenta',
        );
      }
    }
    const result = { accounts: accounts.length, synced, failed, schedulesApplied };
    this.logger.log({ ...result, ready: data.ready }, 'payouts accounts: barrido completado');
    if (failed > 0 && failed === accounts.length) {
      throw new Error(`payouts accounts: fallaron las ${failed} cuentas del barrido`);
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
