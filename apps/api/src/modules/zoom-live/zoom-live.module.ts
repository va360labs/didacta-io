/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { AiModule } from '../../ai/ai.module';
import { ModulesModule } from '../modules.module';
import { ZoomAttendanceSyncWorker } from './zoom-attendance-sync.worker';
import { ZoomCalendarController } from './zoom-calendar.controller';
import { ZoomLiveController } from './zoom-live.controller';
import { ZoomLiveErrorFilter } from './zoom-live-error.filter';
import { ZoomLiveCommunityBridge } from './zoom-live-community.bridge';
import { ZoomLiveNotificationsBridge } from './zoom-live-notifications.bridge';
import { ZoomReminderWorker } from './zoom-reminder.worker';
import { ZoomWebhookController } from './zoom-webhook.controller';

/// Backend del módulo `mod.zoom-live`. Encapsula sus controllers + el
/// filter de errores específico (`ZoomLiveError → 4xx/5xx con códigos
/// estables`).
///
/// Dependencia con `ModuleRegistryService`: los controllers la inyectan
/// para resolver el módulo runtime y delegar en su servicio. Como
/// `ModuleRegistryService` vive en `ModulesModule` (el padre que también
/// importa `ZoomLiveModule`), la relación es circular en el grafo de
/// NestJS — la rompemos con `forwardRef`.
///
/// Convención sub-módulo (ADR-011): todo el código del módulo (back +
/// front) vive bajo `apps/<api|web>/src/modules/<name>/`. El día que
/// `mod.zoom-live` se publique como `*.zip` distribuible vía
/// marketplace, este sub-module deja de existir y `ModuleRegistryService`
/// lo carga dinámicamente — la dependencia circular desaparece sola.
@Module({
  imports: [AuthModule, AiModule, forwardRef(() => ModulesModule)],
  controllers: [ZoomLiveController, ZoomCalendarController, ZoomWebhookController],
  providers: [
    ZoomLiveNotificationsBridge,
    ZoomLiveCommunityBridge,
    ZoomAttendanceSyncWorker,
    ZoomReminderWorker,
    { provide: APP_FILTER, useClass: ZoomLiveErrorFilter },
  ],
})
export class ZoomLiveModule {}
