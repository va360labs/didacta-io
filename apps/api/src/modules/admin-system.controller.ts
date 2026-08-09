/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  ForbiddenException,
  Get,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleContextFactory } from './module-context.factory';
import { OutboxQueueService } from './outbox-queue.service';
import { OutboxRecoveryWorker } from './outbox-recovery.worker';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const OUTBOX_LAG_WARNING_SECONDS = 5 * 60;

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

interface HealthDetailResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  generatedAt: string;
  checks: {
    db: CheckResult;
    redis: RedisCheck;
    storage: StorageCheck;
    smtp: SmtpCheck;
    outbox: OutboxCheck;
  };
}

/**
 * Endpoint consolidado de salud del sistema. Pensado para que el oncall
 * pueda ver en una sola llamada el estado de DB, Redis, S3, SMTP y outbox
 * sin tener que pegarle a `/readyz` y a `/metrics` por separado.
 *
 * Solo `super_admin` y `tenant_admin` pueden consultarlo (incluye latencias
 * y conteos de pendientes que no queremos expuestos públicamente).
 */
@ApiTags('Admin · System')
@ApiBearerAuth()
@Controller('admin/system')
@UseGuards(JwtAuthGuard)
export class AdminSystemController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxQueue: OutboxQueueService,
    private readonly outboxRecovery: OutboxRecoveryWorker,
    private readonly modules: ModuleContextFactory,
  ) {}

  @Get('health-detail')
  @ApiOperation({
    summary: 'Estado consolidado de DB, Redis, S3, SMTP y outbox. Para diagnóstico oncall.',
  })
  async healthDetail(
    @CurrentUser() user: SessionClaims | undefined,
  ): Promise<HealthDetailResponse> {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Solo super_admin / tenant_admin pueden ver el health-detail.',
        code: 'ADMIN_SYSTEM_HEALTH_FORBIDDEN',
      });
    }

    const [db, redis, storage, smtp, outbox] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkStorage(),
      this.checkSmtp(),
      this.checkOutbox(),
    ]);

    const status = aggregateStatus({ db, redis, storage, outbox });

    return {
      status,
      generatedAt: new Date().toISOString(),
      checks: { db, redis, storage, smtp, outbox },
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
}): HealthDetailResponse['status'] {
  if (checks.db.status === 'error') return 'unhealthy';
  if (
    checks.redis.status === 'error' ||
    checks.storage.status === 'error' ||
    checks.outbox.status === 'error'
  ) {
    return 'unhealthy';
  }
  if (checks.outbox.status === 'lagging') return 'degraded';
  return 'healthy';
}
