import { Module } from '@nestjs/common';
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
import { AssessmentsController } from './assessments.controller';
import { AssessmentsAttemptsController } from './assessments-attempts.controller';
import { AssessmentsErrorFilter } from './assessments-error.filter';
import { AssessmentsLearningBridge } from './assessments-learning.bridge';
import { AuditController } from './audit.controller';
import { BillingAdminController } from './billing-admin.controller';
import { BillingController } from './billing.controller';
import { BillingErrorFilter } from './billing-error.filter';
import { BillingLearningBridge } from './billing-learning.bridge';
import { BillingWebhookController } from './billing-webhook.controller';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsErrorFilter } from './subscriptions-error.filter';
import { SubscriptionsLearningBridge } from './subscriptions-learning.bridge';
import { SubscriptionsWebhookController } from './subscriptions-webhook.controller';
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
import { NotificationsBridge } from './notifications.bridge';
import { NotificationsController } from './notifications.controller';
import { NotificationTemplatesController } from './notification-templates.controller';
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
import { FundaeController } from './fundae.controller';
import { FundaeCompaniesController } from './fundae-companies.controller';
import { FundaeGroupsController } from './fundae-groups.controller';
import { FundaeGroupParticipantsController } from './fundae-group-participants.controller';
import { FundaeRlptController } from './fundae-rlpt.controller';
import { FundaeErrorFilter } from './fundae-error.filter';
import { CommunityDigestWorker } from './community-digest.worker';
import { SubscriptionsGraceExpirationWorker } from './subscriptions-grace-expiration.worker';
import {
  CommunityDigestMetrics,
  communityDigestMetricsProviders,
} from './community-digest.metrics';
import { OutboxMetrics, outboxMetricsProviders } from './outbox.metrics';

@Module({
  imports: [AuthModule, AiModule, ZoomLiveModule],
  controllers: [
    CoursesController,
    LearningController,
    CertificatesController,
    AuditController,
    AssessmentsController,
    AssessmentsAttemptsController,
    NotificationsController,
    NotificationTemplatesController,
    FormadorStatsController,
    CommunityController,
    TenantSettingsController,
    ThemingController,
    FundaeController,
    FundaeCompaniesController,
    FundaeGroupsController,
    FundaeGroupParticipantsController,
    FundaeRlptController,
    AdminSystemController,
    StorageController,
    AiTutorController,
    AiProvidersController,
    AiGraderController,
    AiContentController,
    BillingController,
    BillingWebhookController,
    BillingAdminController,
    SubscriptionsController,
    SubscriptionsWebhookController,
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
    SubscriptionsGraceExpirationWorker,
    AssessmentsLearningBridge,
    NotificationsBridge,
    AiTutorBridge,
    ScormLearningBridge,
    BillingLearningBridge,
    SubscriptionsLearningBridge,
    TenantModulesService,
    ModuleAccessInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: ModuleAccessInterceptor },
    { provide: APP_FILTER, useClass: CoursesErrorFilter },
    { provide: APP_FILTER, useClass: LearningErrorFilter },
    { provide: APP_FILTER, useClass: AssessmentsErrorFilter },
    { provide: APP_FILTER, useClass: CertificatesErrorFilter },
    { provide: APP_FILTER, useClass: CommunityErrorFilter },
    { provide: APP_FILTER, useClass: ThemingErrorFilter },
    { provide: APP_FILTER, useClass: FundaeErrorFilter },
    { provide: APP_FILTER, useClass: TenantModulesErrorFilter },
    { provide: APP_FILTER, useClass: AiTutorErrorFilter },
    { provide: APP_FILTER, useClass: AiGraderErrorFilter },
    { provide: APP_FILTER, useClass: AiContentErrorFilter },
    { provide: APP_FILTER, useClass: BillingErrorFilter },
    { provide: APP_FILTER, useClass: SubscriptionsErrorFilter },
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
