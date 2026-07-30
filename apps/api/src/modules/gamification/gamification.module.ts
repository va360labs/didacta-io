import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { GamificationController } from './gamification.controller';
import { GamificationErrorFilter } from './gamification-error.filter';
import { GamificationEventsBridge } from './gamification-events.bridge';
import { GamificationBackfillService } from './gamification-backfill.service';

/// Backend del módulo `mod.gamification` (bloque 1 — puntos, niveles y retos).
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [GamificationController],
  providers: [
    GamificationEventsBridge,
    GamificationBackfillService,
    { provide: APP_FILTER, useClass: GamificationErrorFilter },
  ],
})
export class GamificationModule {}
