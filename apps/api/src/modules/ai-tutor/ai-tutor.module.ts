/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { AiTutorController } from './ai-tutor.controller';
import { AiTutorReviewController } from './ai-tutor-review.controller';
import { AiTutorErrorFilter } from './ai-tutor-error.filter';
import { AiTutorBridge } from './ai-tutor.bridge';

/// Backend del módulo `mod.ai-tutor`. Encapsula el controller (ask +
/// index admin), el filter y el bridge cross-module que escucha eventos
/// de `mod.courses` (course.published / course.unpublished) para
/// mantener el índice del tutor sincronizado.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [AiTutorController, AiTutorReviewController],
  providers: [AiTutorBridge, { provide: APP_FILTER, useClass: AiTutorErrorFilter }],
})
export class AiTutorModule {}
