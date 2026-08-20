/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ModJobsQueueService } from '../marketplace/job-runner/mod-jobs.queue';
import { AllowProvisioning, CurrentUser } from '../auth/decorators';
import { JwtOrProvisioningGuard } from '../auth/jwt-or-provisioning.guard';
import type { SessionClaims } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleContextFactory } from './module-context.factory';
import { OutboxQueueService } from './outbox-queue.service';
import { OutboxRecoveryWorker } from './outbox-recovery.worker';
import { resolveCoreVersion } from '../core-version';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const OUTBOX_LAG_WARNING_SECONDS = 5 * 60;

/**
 * A partir de cuántos trabajos esperando decimos que la cola de módulos va
 * atascada. No es una avería: es la señal de que a esta instancia del pool le
 * hace falta un worker más, que es exactamente la decisión que el plano de
 * control tiene que poder tomar sin entrar a mirar Redis a mano.
 */
const MOD_JOBS_BACKLOG_WARNING = 100;

interface CheckResult {
  status: 'ok' | 'error';
  latencyMs?: number;
  detail?: string | null;
}

interface RedisCheck {
  status: 'ok' | 'disabled' | 'error';
  detail?: string | null;
}

interface StorageCheck {
  status: 'ok' | 'local' | 'error';
  kind: 's3' | 'local-disk';
  detail?: string | null;
}

interface SmtpCheck {
  status: 'ready' | 'configured' | 'unconfigured';
  configuredTenants: number;
}

interface OutboxCheck {
  status: 'ok' | 'lagging' | 'error';
  pendingEvents: number;
  oldestPendingAgeSeconds: number;
  lagWarningThresholdSeconds: number;
  /**
   * Workers de BullMQ atados a la cola `didacta.outbox` en ESTE Redis,
   * incluidos los de otros procesos. Con N réplicas desplegadas debe valer N:
   * un número mayor significa que hay un proceso de más comiéndose eventos del
   * bus, y los que se lleva no llegan a los bridges de nadie más. Ver
   * `OutboxQueueService.countWorkers()`.
   */
  dispatchers: number;
  detail?: string | null;
}

/**
 * Estado de la cola de trabajos de módulos (`didacta.mod-jobs`), la otra cola
 * del host además del outbox.
 *
 * Es lo que le faltaba al plano de control para responder «¿este nodo del pool
 * está sano o hay que darle otro worker?». Sin esto, la única forma de saberlo
 * era abrir Redis a mano, y por eso UC-C504 estaba bloqueado.
 */
interface ModJobsCheck {
  status: 'ok' | 'backlog' | 'disabled' | 'error';
  /** Esperando turno. Es el número que decide si hay atasco. */
  waiting: number;
  /** Ejecutándose ahora mismo. */
  active: number;
  /** Programados para más tarde (`onJobTick` que pidió esperar). */
  delayed: number;
  /** Agotaron sus reintentos. Ninguno se procesará solo. */
  failed: number;
  /** Workers de BullMQ atados a esta cola en ESTE Redis, incluidos otros procesos. */
  workers: number;
  backlogWarningThreshold: number;
  detail?: string | null;
}

interface HealthDetailResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  generatedAt: string;
  /**
   * Versión del núcleo que corre AHORA en este proceso (`DIDACTA_CORE_VERSION`,
   * la etiqueta de la imagen que despliega el pool).
   *
   * El plano de control la compara con la última publicada para medir el lag
   * Community → Cloud, que es la métrica que vigila ADR-001. Preguntársela al
   * propio proceso, y no al orquestador, es lo único que no miente: el
   * orquestador dice qué etiqueta pidió, esto dice qué está corriendo.
   */
  version: string;
  checks: {
    db: CheckResult;
    redis: RedisCheck;
    storage: StorageCheck;
    smtp: SmtpCheck;
    outbox: OutboxCheck;
    modJobs: ModJobsCheck;
  };
}

/**
 * Endpoint consolidado de salud del sistema. Pensado para que el oncall
 * pueda ver en una sola llamada el estado de DB, Redis, S3, SMTP, las dos
 * colas del host y la versión desplegada, sin tener que pegarle a `/readyz` y
 * a `/metrics` por separado.
 *
 * ## Por qué la credencial de provisioning llega hasta aquí
 *
 * Éste es el SEGUNDO controller que abre esa credencial, y el primero fuera de
 * `AdminTenantsController`. No es un detalle: cada ruta que se abre es una
 * operación que una máquina puede hacer sobre TODA la instalación.
 *
 * Se abre porque el plano de control no puede operar un pool a ciegas. Sin
 * esto, «¿este nodo va bien?» solo se responde entrando a mano, y una
 * plataforma gestionada que no sabe el estado de sus nodos no está gestionada.
 * Lo que se abre es **una sola ruta y de solo lectura**: latencias, contadores
 * y la versión. Ni un dato de un alumno, ni una escritura.
 *
 * `provisioning-surface.test.ts` se puso rojo solo al añadir esto, que es para
 * lo que existe: ampliar el alcance obliga a tocar la lista a mano.
 *
 * Para una persona, sigue haciendo falta `super_admin` o `tenant_admin`.
 */
@ApiTags('Admin · System')
@ApiBearerAuth()
@Controller('admin/system')
@UseGuards(JwtOrProvisioningGuard)
export class AdminSystemController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxQueue: OutboxQueueService,
    private readonly outboxRecovery: OutboxRecoveryWorker,
    private readonly modules: ModuleContextFactory,
    private readonly modJobs: ModJobsQueueService,
  ) {}

  @Get('health-detail')
  @AllowProvisioning()
  @ApiOperation({
    summary:
      'Estado consolidado de DB, Redis, S3, SMTP, las dos colas y la versión desplegada. Solo super_admin / tenant_admin o credencial de provisioning.',
    description: [
      'Solo lectura. Devuelve `version` (lo que corre AHORA en este proceso, no lo que',
      'pidió el orquestador) y `checks.modJobs` con los contadores de la cola de',
      'trabajos de módulos: esperando, en curso, aplazados, fallidos y cuántos workers',
      'la atienden.',
      '',
      '`status` agrega: `unhealthy` si la base de datos, Redis, el almacenamiento o',
      'alguna cola no responden; `degraded` si el outbox va con retraso o la cola de',
      'módulos acumula trabajo; `healthy` si no.',
    ].join('\n'),
  })
  async healthDetail(
    @CurrentUser() user: SessionClaims | undefined,
    @Req() req?: FastifyRequest,
  ): Promise<HealthDetailResponse> {
    // Con credencial de provisioning no hay usuario que comprobar: el guard ya
    // validó la credencial Y que esta ruta está en su lista blanca.
    if (!req?.provisioningActor) {
      if (!user) throw new UnauthorizedException();
      if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
        throw new ForbiddenException({
          message: 'Solo super_admin / tenant_admin pueden ver el health-detail.',
          code: 'ADMIN_SYSTEM_HEALTH_FORBIDDEN',
        });
      }
    }

    const [db, redis, storage, smtp, outbox, modJobs] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkStorage(),
      this.checkSmtp(),
      this.checkOutbox(),
      this.checkModJobs(),
    ]);

    const status = aggregateStatus({ db, redis, storage, outbox, modJobs });

    return {
      status,
      generatedAt: new Date().toISOString(),
      // Mismo origen que `/healthz` y que el heartbeat de telemetría: la
      // etiqueta con la que se construyó la imagen.
      version: resolveCoreVersion(),
      checks: { db, redis, storage, smtp, outbox, modJobs },
    };
  }

  private async checkDb(): Promise<CheckResult> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (e) {
      return {
        status: 'error',
        latencyMs: Date.now() - start,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private async checkRedis(): Promise<RedisCheck> {
    if (!this.outboxQueue.isEnabled()) {
      return { status: 'disabled', detail: 'BullMQ deshabilitado por config.' };
    }
    try {
      const ok = await this.outboxQueue.ping();
      return ok ? { status: 'ok' } : { status: 'error', detail: 'ping devolvió false' };
    } catch (e) {
      return { status: 'error', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private async checkStorage(): Promise<StorageCheck> {
    if (!this.modules.isS3Storage()) {
      return { status: 'local', kind: 'local-disk' };
    }
    const storage = this.modules.getStorage();
    if (!storage.ping) return { status: 'local', kind: 's3', detail: 'ping no implementado' };
    try {
      const ok = await storage.ping();
      return ok ? { status: 'ok', kind: 's3' } : { status: 'error', kind: 's3' };
    } catch (e) {
      return {
        status: 'error',
        kind: 's3',
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private async checkSmtp(): Promise<SmtpCheck> {
    // El SmtpAdapterService es stateless y per-tenant. La señal útil de
    // salud es cuántos tenants tienen credenciales SMTP configuradas: 0
    // significa que ningún email saldrá hasta que un admin las complete.
    const configuredTenants = await this.prisma.tenantSetting.count({
      where: { moduleName: 'notifications', key: 'smtp', valueCipher: { not: null } },
    });
    return {
      status: configuredTenants > 0 ? 'configured' : 'unconfigured',
      configuredTenants,
    };
  }

  /**
   * Contadores de `didacta.mod-jobs`. Sin Redis la cola no arranca y eso NO es
   * un fallo: es el modo normal de una instalación de desarrollo, y de
   * cualquiera que no use módulos con trabajos en segundo plano. Se informa
   * como `disabled` para que nadie lo confunda con una avería.
   */
  private async checkModJobs(): Promise<ModJobsCheck> {
    const vacio = {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      workers: 0,
      backlogWarningThreshold: MOD_JOBS_BACKLOG_WARNING,
    };
    const queue = this.modJobs.getQueue();
    if (!queue) {
      return { status: 'disabled', ...vacio, detail: 'Sin REDIS_URL: la cola no se inicializa.' };
    }
    try {
      const [counts, workers] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        queue.getWorkers(),
      ]);
      const waiting = counts['waiting'] ?? 0;
      return {
        status: waiting > MOD_JOBS_BACKLOG_WARNING ? 'backlog' : 'ok',
        waiting,
        active: counts['active'] ?? 0,
        delayed: counts['delayed'] ?? 0,
        failed: counts['failed'] ?? 0,
        workers: workers.length,
        backlogWarningThreshold: MOD_JOBS_BACKLOG_WARNING,
      };
    } catch (e) {
      return { status: 'error', ...vacio, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private async checkOutbox(): Promise<OutboxCheck> {
    try {
      const [sample, dispatchers] = await Promise.all([
        this.outboxRecovery.sampleLag(),
        this.outboxQueue.countWorkers(),
      ]);
      const lagging = sample.oldestAgeSeconds > OUTBOX_LAG_WARNING_SECONDS;
      return {
        status: lagging ? 'lagging' : 'ok',
        pendingEvents: sample.pending,
        oldestPendingAgeSeconds: sample.oldestAgeSeconds,
        lagWarningThresholdSeconds: OUTBOX_LAG_WARNING_SECONDS,
        dispatchers,
      };
    } catch (e) {
      return {
        status: 'error',
        pendingEvents: 0,
        oldestPendingAgeSeconds: 0,
        lagWarningThresholdSeconds: OUTBOX_LAG_WARNING_SECONDS,
        dispatchers: 0,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function aggregateStatus(checks: {
  db: CheckResult;
  redis: RedisCheck;
  storage: StorageCheck;
  outbox: OutboxCheck;
  modJobs: ModJobsCheck;
}): HealthDetailResponse['status'] {
  if (checks.db.status === 'error') return 'unhealthy';
  if (
    checks.redis.status === 'error' ||
    checks.storage.status === 'error' ||
    checks.outbox.status === 'error' ||
    checks.modJobs.status === 'error'
  ) {
    return 'unhealthy';
  }
  // Acumular trabajo no es una avería: es la señal de que hace falta capacidad.
  // Por eso degrada y no tumba — un nodo con cola larga sigue sirviendo el aula.
  if (checks.outbox.status === 'lagging' || checks.modJobs.status === 'backlog') {
    return 'degraded';
  }
  return 'healthy';
}
