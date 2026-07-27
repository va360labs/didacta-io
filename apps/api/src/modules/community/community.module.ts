import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { CommunityController } from './community.controller';
import { CommunityPublicController } from './community-public.controller';
import { CommunityApiController } from './community-api.controller';
import { CommunityErrorFilter } from './community-error.filter';
import { CommunityDigestWorker } from './community-digest.worker';
import { CommunityBroadcastWorker } from './community-broadcast.worker';
import {
  CommunityDigestMetrics,
  communityDigestMetricsProviders,
} from './community-digest.metrics';

/// Backend del módulo `mod.community`. Encapsula el controller (posts,
/// comentarios, reacciones, tags, moderación, preferencias usuario), el
/// filter, el worker BullMQ del digest semanal y sus métricas Prometheus.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule
/// para romper el ciclo a través de ModuleRegistryService.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [CommunityController, CommunityPublicController, CommunityApiController],
  providers: [
    ...communityDigestMetricsProviders,
    CommunityDigestMetrics,
    CommunityDigestWorker,
    CommunityBroadcastWorker,
    { provide: APP_FILTER, useClass: CommunityErrorFilter },
  ],
})
export class CommunityModule {}
