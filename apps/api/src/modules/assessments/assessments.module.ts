import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { AssessmentsController } from './assessments.controller';
import { AssessmentsAttemptsController } from './assessments-attempts.controller';
import { AssessmentsErrorFilter } from './assessments-error.filter';
import { AssessmentsLearningBridge } from './assessments-learning.bridge';

/// Backend del módulo `mod.assessments`. Encapsula los controllers de
/// formador (`/api/v1/admin/assessments`) y alumno (`/api/v1/modules/assessments`),
/// el filter que mapea `AssessmentsError → 4xx/5xx con códigos estables`,
/// y el bridge cross-module que escucha `assessments.attempt.passed` para
/// marcar lecciones de tipo QUIZ como completadas en `mod.learning`.
///
/// Dependencia con `ModuleRegistryService`: tanto controllers como bridge
/// la inyectan para resolver el módulo runtime y delegar en su servicio.
/// Como `ModuleRegistryService` vive en `ModulesModule` (el padre que también
/// importa `AssessmentsModule`), la relación es circular en el grafo de
/// NestJS — la rompemos con `forwardRef`.
///
/// Convención sub-módulo (ADR-011): todo el código del módulo (back +
/// front) vive bajo `apps/<api|web>/src/modules/<name>/`. Cuando
/// `mod.assessments` se publique como `*.zip` distribuible vía marketplace,
/// este sub-module deja de existir y `ModuleRegistryService` lo carga
/// dinámicamente.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [AssessmentsController, AssessmentsAttemptsController],
  providers: [
    AssessmentsLearningBridge,
    { provide: APP_FILTER, useClass: AssessmentsErrorFilter },
  ],
})
export class AssessmentsModule {}
