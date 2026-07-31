/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModJobsQueueService } from './job-runner/mod-jobs.queue';
import type { ModuleJobLifecycleConfig } from './module-manifest.schema';
import {
  BlockedSandboxedJobs,
  JobsError,
  type SandboxedJobs,
  type ScheduleTickArgs,
} from './sandboxed-jobs.types';

/**
 * Factory que construye `SandboxedJobs` por (módulo, tenant) — patrón
 * idéntico a `ScopedDidactaApiFactory` (alpha.52). El dispatcher la usa
 * por request para inyectar `ctx.jobs` con el `tenantId` y `moduleName`
 * congelados en la closure: el módulo NO puede encolar jobs en otro
 * tenant ni en otro módulo, ni siquiera por bug propio.
 *
 * Si el módulo NO declara `manifest.jobLifecycle`, la factory devuelve
 * `BlockedSandboxedJobs` (rechaza con `JOBS_NOT_DECLARED` + mensaje
 * accionable sobre cómo declarar el bloque).
 */
@Injectable()
export class ScopedJobsApiFactory {
  constructor(
    private readonly modJobsQueue: ModJobsQueueService,
    private readonly logger: PinoLogger,
  ) {}

  /// Construye el cliente `ctx.jobs` para un request concreto. `tenantId`
  /// viene del JWT del request (resuelto por el dispatcher); `moduleName`
  /// de la route registrada; `jobLifecycleConfig` del manifest memoizado
  /// en el router.
  build(
    moduleName: string,
    tenantId: string,
    jobLifecycleConfig: ModuleJobLifecycleConfig | null,
  ): SandboxedJobs {
    if (!jobLifecycleConfig) {
      return new BlockedSandboxedJobs(moduleName);
    }
    return new ScopedJobs(this.modJobsQueue, this.logger, moduleName, tenantId);
  }
}

/**
 * Impl real. `tenantId` y `moduleName` viven solo en la closure —
 * inmutables tras la construcción. Cualquier llamada a `scheduleTick()`
 * usa la queue del host con esos valores y el `tickIndex=0` fijo (el
 * primer tick es siempre el kickoff; los siguientes los re-encola el
 * worker cuando `onJobTick` retorna `{ status: 'continue' }`).
 */
class ScopedJobs implements SandboxedJobs {
  constructor(
    private readonly modJobsQueue: ModJobsQueueService,
    private readonly logger: PinoLogger,
    private readonly moduleName: string,
    private readonly tenantId: string,
  ) {}

  async scheduleTick(args: ScheduleTickArgs): Promise<void> {
    if (!this.modJobsQueue.isEnabled()) {
      throw new JobsError(
        'JOBS_QUEUE_DISABLED',
        `mod-jobs queue deshabilitada en el host (REDIS_URL ausente o NODE_ENV=test). ` +
          `El job ${args.jobId} se persistió en BD pero NO se procesará hasta que el ` +
          `operador setee REDIS_URL y reinicie el API.`,
      );
    }
    if (!args.jobId || typeof args.jobId !== 'string') {
      throw new JobsError(
        'JOBS_NETWORK',
        `scheduleTick requiere args.jobId como string no vacío (recibido: ${JSON.stringify(args.jobId)}).`,
      );
    }
    const delaySec = args.delaySec ?? 0;
    try {
      await this.modJobsQueue.enqueue(
        {
          moduleName: this.moduleName,
          jobId: args.jobId,
          tenantId: this.tenantId,
          tickIndex: 0,
        },
        delaySec > 0 ? { delaySec } : {},
      );
      this.logger.log(
        `[mod:${this.moduleName}] ctx.jobs.scheduleTick — jobId=${args.jobId} tenant=${this.tenantId} delay=${delaySec}s`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new JobsError(
        'JOBS_NETWORK',
        `Redis/BullMQ rechazó el enqueue del job ${args.jobId}: ${msg}`,
        err,
      );
    }
  }
}
