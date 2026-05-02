import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { AiContentController } from './ai-content.controller';
import { AiContentErrorFilter } from './ai-content-error.filter';
import { AiGraderController } from './ai-grader.controller';
import { AiGraderErrorFilter } from './ai-grader-error.filter';
import { AiProvidersController } from './ai-providers.controller';
import { AiTutorBridge } from './ai-tutor.bridge';
import { AiTutorController } from './ai-tutor.controller';
import { AiTutorErrorFilter } from './ai-tutor-error.filter';
import { AdminSystemController } from './admin-system.controller';
import { AssessmentsModule } from './assessments/assessments.module';
import { AuditController } from './audit.controller';
import { BillingModule } from './billing/billing.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { CertificatesController } from './certificates.controller';
import { CertificatesErrorFilter } from './certificates-error.filter';
import { CommunityController } from './community.controller';
import { CommunityErrorFilter } from './community-error.filter';
import { CoursesController } from './courses.controller';
import { CoursesErrorFilter } from './courses-error.filter';
import { FormadorStatsController } from './formador-stats.controller';
import { LearningController } from './learning.controller';
import { LearningErrorFilter } from './learning-error.filter';
import { ModuleAccessInterceptor } from './module-access.interceptor';
import { ModuleContextFactory } from './module-context.factory';
import { ModuleRegistryService } from './module-registry.service';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxQueueService } from './outbox-queue.service';
import { OutboxRecoveryWorker } from './outbox-recovery.worker';
import { ScormLearningBridge } from './scorm-learning.bridge';
import { StorageController } from './storage.controller';
import { TenantModulesService } from './tenant-modules.service';
import { TenantModulesErrorFilter } from './tenant-modules-error.filter';
import { MeModulesController } from './me-modules.controller';
import { TenantSettingsController } from './tenant-settings.controller';
import { ThemingController } from './theming.controller';
import { ThemingErrorFilter } from './theming-error.filter';
import { ZoomLiveModule } from './zoom-live/zoom-live.module';
import { FundaeModule } from './fundae/fundae.module';
import { CommunityDigestWorker } from './community-digest.worker';
import {
  CommunityDigestMetrics,
  communityDigestMetricsProviders,
} from './community-digest.metrics';
import { OutboxMetrics, outboxMetricsProviders } from './outbox.metrics';

@Module({
  imports: [
    AuthModule,
    AiModule,
    forwardRef(() => ZoomLiveModule),
    forwardRef(() => NotificationsModule),
    forwardRef(() => FundaeModule),
    forwardRef(() => AssessmentsModule),
    forwardRef(() => BillingModule),
    forwardRef(() => SubscriptionsModule),
  ],
  controllers: [
    CoursesController,
    LearningController,
    CertificatesController,
    AuditController,
    FormadorStatsController,
    CommunityController,
    TenantSettingsController,
    ThemingController,
    AdminSystemController,
    StorageController,
    AiTutorController,
    AiProvidersController,
    AiGraderController,
    AiContentController,
    // GET /me/modules — sidebar gating UI (módulos activos + capabilities EE).
    MeModulesController,
  ],
  providers: [
    ...communityDigestMetricsProviders,
    CommunityDigestMetrics,
    ...outboxMetricsProviders,
    OutboxMetrics,
    OutboxQueueService,
    ModuleContextFactory,
    ModuleRegistryService,
    OutboxRecoveryWorker,
    CommunityDigestWorker,
    AiTutorBridge,
    ScormLearningBridge,
    TenantModulesService,
    ModuleAccessInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: ModuleAccessInterceptor },
    { provide: APP_FILTER, useClass: CoursesErrorFilter },
    { provide: APP_FILTER, useClass: LearningErrorFilter },
    { provide: APP_FILTER, useClass: CertificatesErrorFilter },
    { provide: APP_FILTER, useClass: CommunityErrorFilter },
    { provide: APP_FILTER, useClass: ThemingErrorFilter },
    { provide: APP_FILTER, useClass: TenantModulesErrorFilter },
    { provide: APP_FILTER, useClass: AiTutorErrorFilter },
    { provide: APP_FILTER, useClass: AiGraderErrorFilter },
    { provide: APP_FILTER, useClass: AiContentErrorFilter },
  ],
  exports: [
    ModuleRegistryService,
    OutboxQueueService,
    ModuleContextFactory,
    TenantModulesService,
    ModuleAccessInterceptor,
  ],
})
export class ModulesModule {}
