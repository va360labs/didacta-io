import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { SurveysController } from './surveys.controller';
import { SurveysErrorFilter } from './surveys-error.filter';
import { SurveysZoomBridge } from './surveys-zoom.bridge';

/// Backend del módulo `mod.surveys` (bloque 2 — feedback/NPS): encuesta
/// post-clase anónima + resultados agregados para admin.
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [SurveysController],
  providers: [SurveysZoomBridge, { provide: APP_FILTER, useClass: SurveysErrorFilter }],
})
export class SurveysModule {}
