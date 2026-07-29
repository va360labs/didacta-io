import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { ResourcesController } from './resources.controller';
import { ResourcesErrorFilter } from './resources-error.filter';

/// Backend del módulo `mod.resources` (bloque 4 — biblioteca de recursos).
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [ResourcesController],
  providers: [{ provide: APP_FILTER, useClass: ResourcesErrorFilter }],
})
export class ResourcesModule {}
