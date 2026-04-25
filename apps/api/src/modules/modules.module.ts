import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { CoursesController } from './courses.controller';
import { CoursesErrorFilter } from './courses-error.filter';
import { ModuleContextFactory } from './module-context.factory';
import { ModuleRegistryService } from './module-registry.service';

@Module({
  imports: [AuthModule],
  controllers: [CoursesController],
  providers: [
    ModuleContextFactory,
    ModuleRegistryService,
    { provide: APP_FILTER, useClass: CoursesErrorFilter },
  ],
  exports: [ModuleRegistryService],
})
export class ModulesModule {}
