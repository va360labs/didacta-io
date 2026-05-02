import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { AiContentController } from './ai-content.controller';
import { AiContentErrorFilter } from './ai-content-error.filter';

/// Backend del módulo `mod.ai-content`. Encapsula el controller (generación
/// human-in-the-loop de summaries, flashcards y quizzes a partir del texto
/// de la lección) y el filter.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [AiContentController],
  providers: [{ provide: APP_FILTER, useClass: AiContentErrorFilter }],
})
export class AiContentModule {}
