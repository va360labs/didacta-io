import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { AiModule } from '../../ai/ai.module';
import { ZoomLiveController } from './zoom-live.controller';
import { ZoomLiveErrorFilter } from './zoom-live-error.filter';
import { ZoomWebhookController } from './zoom-webhook.controller';

/// Backend del módulo `mod.zoom-live`. Encapsula sus controllers + el
/// filter de errores específico (`ZoomLiveError → 4xx/5xx con códigos
/// estables). El módulo padre `ModulesModule` lo importa; cualquier
/// dependencia del core viene del re-export de ese módulo padre.
///
/// Convención sub-módulo (ADR-008 PR refactor): todo el código (back +
/// front) del módulo vive bajo `apps/<api|web>/src/modules/<name>/`. El
/// día que `mod.zoom-live` se publique como `*.didactamod` distribuible
/// vía marketplace, este módulo será exportable sin tocar el core —
/// solo cambia el bus de carga (DynamicModule en lugar de import
/// estático).
@Module({
  imports: [AuthModule, AiModule],
  controllers: [ZoomLiveController, ZoomWebhookController],
  providers: [{ provide: APP_FILTER, useClass: ZoomLiveErrorFilter }],
})
export class ZoomLiveModule {}
