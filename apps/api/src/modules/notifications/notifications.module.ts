/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { NotificationsBridge } from './notifications.bridge';
import { NotificationsController } from './notifications.controller';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationStreamController } from './realtime/notification-stream.controller';
import { NotificationStreamService } from './realtime/notification-stream.service';

/// Backend del módulo `mod.notifications`. Encapsula sus controllers
/// (CRUD del bell del user, CRUD de templates per-tenant) y el bridge
/// que reacciona a eventos de otros módulos para crear notifications.
///
/// NO incluye `SmtpAdapterService` ni `PrismaNotificationHubService`
/// porque ambos son **infrastructure compartida del core**: SMTP lo
/// usan auth (password reset), billing (Stripe webhook), etc., y el
/// `NotificationHub` lo consume `ModuleContext` para que cualquier
/// módulo pueda emitir notifications. Se quedan registrados en
/// `ModulesModule` (parent) — este sub-module solo añade la cara
/// visible del módulo (endpoints REST + bridge).
///
/// Convención ADR-011: `forwardRef(() => ModulesModule)` rompe el ciclo
/// `ModulesModule → NotificationsModule → ModulesModule (NotificationHub
/// vía PrismaNotificationHubService)`.
/// alpha.79 — añade el subsistema realtime (SSE + Redis pub/sub):
///   - `NotificationStreamController`: stream SSE + emisión de ticket.
///   - `NotificationStreamService`: subscriber Redis dedicado + fan-out local.
/// El publisher (`NotificationRealtimePublisher`) NO se registra aquí: lo
/// construye `ModuleContextFactory` (en `ModulesModule`) junto a SMTP/cipher,
/// porque lo consume el `PrismaNotificationHubService` que vive en ese contexto
/// (mismo razonamiento que SMTP/NotificationHub — infra compartida del core).
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [
    NotificationsController,
    NotificationTemplatesController,
    NotificationStreamController,
  ],
  providers: [NotificationsBridge, NotificationStreamService],
  exports: [NotificationsBridge],
})
export class NotificationsModule {}
