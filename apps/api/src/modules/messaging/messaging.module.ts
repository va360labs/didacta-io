/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { MessagingController } from './messaging.controller';
import { MessagingErrorFilter } from './messaging-error.filter';
import { MessagingPresenceService } from './messaging-presence.service';
import { MessagingRateLimitGuard } from './messaging-rate-limit.guard';
import { MessagingRealtimePublisher } from './messaging-realtime.publisher';
import { MessagingStreamController } from './messaging-stream.controller';
import { MessagingStreamService } from './messaging-stream.service';

/// Backend del módulo `mod.messaging`: controller REST (conversaciones,
/// mensajes, búsqueda de miembros), stream SSE con ticket y publisher Redis
/// del realtime. El service de dominio vive en modules/messaging/ y se obtiene
/// vía ModuleRegistryService.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [MessagingController, MessagingStreamController],
  providers: [
    MessagingRealtimePublisher,
    MessagingPresenceService,
    MessagingRateLimitGuard,
    MessagingStreamService,
    { provide: APP_FILTER, useClass: MessagingErrorFilter },
  ],
})
export class MessagingModule {}
