import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { RestrictionController, RestrictionScopesController } from './restriction.controller';
import { RestrictionInterceptor } from './restriction.interceptor';
import { RestrictionService } from './restriction.service';

/**
 * Moderación de personas (no de contenido).
 *
 * Ocultar un post concreto ya lo hace `mod.community`; aquí se sanciona a
 * quien lo escribe, y la sanción cruza módulos: comunidad, mensajería,
 * subidas y tutor IA. Por eso vive en el core.
 *
 * Registra `RestrictionInterceptor` como APP_INTERCEPTOR global —
 * mismo patrón que `ModuleAccessInterceptor`— para que ningún módulo tenga
 * que enterarse de que las sanciones existen.
 *
 * Importa AuthModule por PrismaAuditLogService: toda sanción y todo
 * levantamiento quedan en el audit log.
 */
@Module({
  imports: [AuthModule],
  controllers: [RestrictionController, RestrictionScopesController],
  providers: [
    RestrictionService,
    RestrictionInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: RestrictionInterceptor },
  ],
  exports: [RestrictionService],
})
export class ModerationModule {}
