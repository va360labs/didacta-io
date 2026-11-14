/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ModulesModule } from '../modules.module';
import { RetentionController } from './retention.controller';
import { RetentionErrorFilter } from './retention-error.filter';
import { RetentionHostPorts } from './retention-host-ports';
import { RetentionWorker } from './retention.worker';

/// Backend del módulo `mod.retention` (mensajes automáticos y miembros en
/// riesgo). El servicio de dominio vive en modules/retention/ y se obtiene vía
/// ModuleRegistryService; aquí solo hay capa fina: controller, barrido
/// programado y el adaptador de puertos (que necesita el publicador en tiempo
/// real de la mensajería, por eso importa MessagingModule).
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule), forwardRef(() => MessagingModule)],
  controllers: [RetentionController],
  providers: [
    RetentionHostPorts,
    RetentionWorker,
    { provide: APP_FILTER, useClass: RetentionErrorFilter },
  ],
})
export class RetentionModule {}
