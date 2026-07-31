/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { AiGraderController } from './ai-grader.controller';
import { AiGraderErrorFilter } from './ai-grader-error.filter';

/// Backend del módulo `mod.ai-grader`. Encapsula el controller (rúbricas
/// + sugerencias para corrección manual) y el filter.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [AiGraderController],
  providers: [{ provide: APP_FILTER, useClass: AiGraderErrorFilter }],
})
export class AiGraderModule {}
