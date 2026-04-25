import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { CertificatesController } from './certificates.controller';
import { CoursesController } from './courses.controller';
import { CoursesErrorFilter } from './courses-error.filter';
import { LearningController } from './learning.controller';
import { LearningErrorFilter } from './learning-error.filter';
import { ModuleContextFactory } from './module-context.factory';
import { ModuleRegistryService } from './module-registry.service';

@Module({
  imports: [AuthModule],
  controllers: [CoursesController, LearningController, CertificatesController],
  providers: [
    ModuleContextFactory,
    ModuleRegistryService,
    { provide: APP_FILTER, useClass: CoursesErrorFilter },
    { provide: APP_FILTER, useClass: LearningErrorFilter },
  ],
  exports: [ModuleRegistryService],
})
export class ModulesModule {}
