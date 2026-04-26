import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AssessmentsController } from './assessments.controller';
import { AssessmentsAttemptsController } from './assessments-attempts.controller';
import { AssessmentsErrorFilter } from './assessments-error.filter';
import { AssessmentsLearningBridge } from './assessments-learning.bridge';
import { AuditController } from './audit.controller';
import { CertificatesController } from './certificates.controller';
import { CommunityController } from './community.controller';
import { CommunityErrorFilter } from './community-error.filter';
import { CoursesController } from './courses.controller';
import { CoursesErrorFilter } from './courses-error.filter';
import { FormadorStatsController } from './formador-stats.controller';
import { LearningController } from './learning.controller';
import { LearningErrorFilter } from './learning-error.filter';
import { ModuleContextFactory } from './module-context.factory';
import { ModuleRegistryService } from './module-registry.service';
import { NotificationsBridge } from './notifications.bridge';
import { NotificationsController } from './notifications.controller';
import { OutboxQueueService } from './outbox-queue.service';
import { OutboxRecoveryWorker } from './outbox-recovery.worker';
import { TenantSettingsController } from './tenant-settings.controller';
import { ThemingController } from './theming.controller';
import { ThemingErrorFilter } from './theming-error.filter';

@Module({
  imports: [AuthModule],
  controllers: [
    CoursesController,
    LearningController,
    CertificatesController,
    AuditController,
    AssessmentsController,
    AssessmentsAttemptsController,
    NotificationsController,
    FormadorStatsController,
    CommunityController,
    TenantSettingsController,
    ThemingController,
  ],
  providers: [
    OutboxQueueService,
    ModuleContextFactory,
    ModuleRegistryService,
    OutboxRecoveryWorker,
    AssessmentsLearningBridge,
    NotificationsBridge,
    { provide: APP_FILTER, useClass: CoursesErrorFilter },
    { provide: APP_FILTER, useClass: LearningErrorFilter },
    { provide: APP_FILTER, useClass: AssessmentsErrorFilter },
    { provide: APP_FILTER, useClass: CommunityErrorFilter },
    { provide: APP_FILTER, useClass: ThemingErrorFilter },
  ],
  exports: [ModuleRegistryService, OutboxQueueService, ModuleContextFactory],
})
export class ModulesModule {}
