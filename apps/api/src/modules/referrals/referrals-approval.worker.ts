import {
  forwardRef,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleRegistryService } from '../module-registry.service';

const QUEUE_NAME = 'didacta.referrals.approval';
const REPEAT_PATTERN = process.env['REFERRALS_APPROVAL_CRON'] ?? '30 * * * *'; // cada hora, min 30 UTC

type ApprovalJobData = Record<string, never>;

/**
 * Worker BullMQ que aprueba comisiones de referidos con la garantía vencida
 * (PENDING → APPROVED cuando `approveAfter <= now`). Patrón idéntico a
 * SubscriptionsGraceExpirationWorker: cada hora (min 30 para no coincidir con
 * el barrido de grace), repeat-key estable, sin Redis no arranca (warn), y en
 * NODE_ENV=test tampoco.
 */
@Injectable()
export class ReferralsApprovalWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<ApprovalJobData>;
  private worker?: Worker<ApprovalJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — referrals approval scheduler no arranca');
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;

    this.queue = new Queue<ApprovalJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 30 * 24 * 3600, count: 50 },
        removeOnFail: { age: 30 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker<ApprovalJobData>(
      QUEUE_NAME,
      async () => {
        await this.processJob();
      },
      { connection: this.workerConnection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'referrals approval job falló');
    });

    await this.queue.add('hourly', {} as ApprovalJobData, {
      repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' },
      jobId: 'hourly-referrals-approval',
    });

    this.logger.log(`referrals approval scheduler activo (cron='${REPEAT_PATTERN}' UTC)`);
  }

  /** Disparo manual (QA / futuro endpoint admin). In-process si no hay Redis. */
  async triggerNow(): Promise<void> {
    if (!this.queue) {
      await this.processJob();
      return;
    }
    await this.queue.add('manual', {} as ApprovalJobData, { jobId: `manual-${Date.now()}` });
  }

  private async processJob(): Promise<void> {
    const startedAt = Date.now();
    try {
      const approved = await this.registry.getReferralsService().approveDueCommissions();
      this.logger.log(
        { approved, elapsedMs: Date.now() - startedAt },
        'referrals approval job completado',
      );
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'referrals approval: approveDueCommissions() lanzó error',
      );
      throw err; // BullMQ aplica retry exponencial
    }
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
