/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { GamificationController } from './gamification.controller';
import { GamificationErrorFilter } from './gamification-error.filter';
import { GamificationEventsBridge } from './gamification-events.bridge';
import { GamificationNotificationsBridge } from './gamification-notifications.bridge';
import { GamificationBackfillService } from './gamification-backfill.service';
import { GamificationAnniversaryWorker } from './gamification-anniversary.worker';
import { GamificationRetentionBridge } from './gamification-retention.bridge';
import { GamificationRetentionController } from './gamification-retention.controller';
import { GamificationRetentionHost } from './gamification-retention.host';

/// Backend del módulo `mod.gamification` (bloque 1 — puntos, niveles y retos).
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [GamificationController, GamificationRetentionController],
  providers: [
    GamificationEventsBridge,
    GamificationNotificationsBridge,
    GamificationBackfillService,
    // Retención estilo Skool: desbloqueo por nivel, rachas, insignias,
    // premios automáticos y celebraciones en la comunidad.
    GamificationRetentionHost,
    GamificationRetentionBridge,
    GamificationAnniversaryWorker,
    { provide: APP_FILTER, useClass: GamificationErrorFilter },
  ],
})
export class GamificationModule {}
