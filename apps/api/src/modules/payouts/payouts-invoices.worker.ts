/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  madridDate,
  previousMonthKey,
  type InvoiceRunReport,
  type MonthKey,
} from '@didacta/mod-payouts';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PayoutsInvoiceMailer } from './payouts-invoice-mailer';
import { PayoutsRuntime } from './payouts-runtime.service';

const QUEUE_NAME = 'didacta.payouts.invoices';
/** Cada día a las 06:20 de Madrid. */
const DAILY_PATTERN = process.env['PAYOUTS_INVOICES_CRON'] ?? '20 6 * * *';
/**
 * Hasta qué día del mes siguiente se factura: las facturas a empresarios se
 * expiden antes del día 16 (art. 11 del RD 1619/2012).
 */
const LAST_ISSUE_DAY = 15;

export interface PayoutsInvoicesRunResult extends InvoiceRunReport {
  readonly emails: { readonly sent: number; readonly failed: number };
}

/**
 * Factura mensual de la comisión (BullMQ, mismo patrón que el conciliador).
 *
 * Cada día, del 1 al 15, factura el mes anterior: el primer día emite casi
 * todo; los días siguientes recogen a quien se quedó esperando (NIF-IVA
 * pendiente de VIES) y no repiten nada (un hueco por aula, mes y moneda).
 * Todos los días, además, manda los correos que no salieron y sustituye las
 * facturas de quien completó sus datos fiscales.
 *
 * Sin `REDIS_URL` no se programa; queda el botón del super_admin
 * (`POST /modules/payouts/admin/invoices/run`). Sin datos del emisor
 * (`PAYMENTS_PLATFORM_INVOICE_ISSUER_*`) no hace nada.
 */
@Injectable()
export class PayoutsInvoicesWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly mailer: PayoutsInvoiceMailer,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.runtime.invoices) {
      this.logger.warn(
        'facturas de la comisión APAGADAS: faltan los datos del emisor (PAYMENTS_PLATFORM_INVOICE_ISSUER_*)',
      );
      return;
    }
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL no seteada — la factura mensual no se programa; queda el botón del super_admin',
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
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
        removeOnComplete: { age: 60 * 24 * 3600, count: 100 },
        removeOnFail: { age: 60 * 24 * 3600, count: 100 },
      },
    });
    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        await this.daily();
      },
      { connection: this.workerConnection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'payouts invoices job falló');
    });
    await this.queue.add(
      'daily',
      {},
      {
        repeat: { pattern: DAILY_PATTERN, tz: 'Europe/Madrid' },
        jobId: 'payouts-invoices-daily',
      },
    );
    this.logger.log(`factura mensual de la comisión activa ('${DAILY_PATTERN}' Europe/Madrid)`);
  }

  /** La pasada diaria: factura el mes anterior si aún toca, y manda correos. */
  async daily(now: Date = new Date()): Promise<PayoutsInvoicesRunResult | null> {
    if (madridDate(now).day > LAST_ISSUE_DAY) {
      // Fuera del plazo del mes: solo sustituciones (datos completados) y correos.
      const substitutions = await this.runtime.invoices?.runSubstitutions();
      const emails = await this.mailer.sendPending();
      this.logger.log(
        { substitutions: substitutions?.issued ?? 0, emails },
        'payouts.invoices: fuera de plazo de emisión; solo sustituciones y correos',
      );
      return null;
    }
    return this.run({ month: previousMonthKey(now) });
  }

  /** Una pasada para un mes (por defecto, el anterior). Público para el botón y los tests. */
  async run(
    options: { month?: MonthKey; tenantId?: string } = {},
  ): Promise<PayoutsInvoicesRunResult> {
    const invoices = this.runtime.invoices;
    if (!invoices) {
      return {
        month: options.month ?? previousMonthKey(new Date()),
        tenants: 0,
        issued: 0,
        outcomes: {},
        errors: 0,
        invoiceIds: [],
        emails: { sent: 0, failed: 0 },
      };
    }
    const month = options.month ?? previousMonthKey(new Date());
    const report = await invoices.runMonth(month, { tenantId: options.tenantId });
    const emails = await this.mailer.sendPending();
    this.logger.log({ ...report, emails }, 'payouts.invoices: pasada terminada');
    return { ...report, emails };
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
