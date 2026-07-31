/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ModuleContextFactory } from '../modules/module-context.factory';
import { OutboxQueueService } from '../modules/outbox-queue.service';
import { PrismaService } from '../prisma/prisma.service';

interface LivenessResponse {
  status: 'ok';
  service: string;
  version: string;
  uptime: number;
  timestamp: string;
}

interface ReadinessResponse extends LivenessResponse {
  checks: {
    db: 'ok' | 'error';
    redis: 'ok' | 'disabled' | 'error';
    storage: 'ok' | 'local' | 'error';
  };
}

@ApiTags('Health')
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxQueue: OutboxQueueService,
    private readonly modules: ModuleContextFactory,
  ) {}

  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'El servicio está vivo.' })
  healthz(): LivenessResponse {
    return this.liveness();
  }

  @Get('readyz')
  @ApiOperation({
    summary: 'Readiness probe — verifica DB y Redis. 503 si alguna dependencia falla.',
  })
  @ApiOkResponse({ description: 'El servicio está listo para aceptar tráfico.' })
  @ApiServiceUnavailableResponse({ description: 'Una o más dependencias están degradadas.' })
  async readyz(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessResponse> {
    const liveness = this.liveness();
    const [dbOk, redisStatus, storageStatus] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkStorage(),
    ]);
    const allOk =
      dbOk &&
      (redisStatus === 'ok' || redisStatus === 'disabled') &&
      (storageStatus === 'ok' || storageStatus === 'local');

    if (!allOk) {
      reply.code(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      ...liveness,
      checks: {
        db: dbOk ? 'ok' : 'error',
        redis: redisStatus,
        storage: storageStatus,
      },
    };
  }

  @Get('livez')
  @HttpCode(HttpStatus.OK)
  livez(): LivenessResponse {
    return this.liveness();
  }

  private liveness(): LivenessResponse {
    return {
      status: 'ok',
      service: 'api',
      // El runtime arranca `node dist/main.js` (no vía npm), así que
      // `npm_package_version` no existe y daba siempre '0.0.0'. DIDACTA_CORE_VERSION
      // lo fija el deploy (release.yml) a la versión del build,
      // así healthz reporta la versión real desplegada.
      version: process.env['DIDACTA_CORE_VERSION'] ?? process.env['npm_package_version'] ?? '0.0.0',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<'ok' | 'disabled' | 'error'> {
    if (!this.outboxQueue.isEnabled()) return 'disabled';
    return (await this.outboxQueue.ping()) ? 'ok' : 'error';
  }

  private async checkStorage(): Promise<'ok' | 'local' | 'error'> {
    if (!this.modules.isS3Storage()) return 'local';
    const storage = this.modules.getStorage();
    if (!storage.ping) return 'local';
    return (await storage.ping()) ? 'ok' : 'error';
  }
}
