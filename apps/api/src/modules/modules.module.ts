import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { AiContentModule } from './ai-content/ai-content.module';
import { AiGraderModule } from './ai-grader/ai-grader.module';
import { AiProvidersController } from './ai-providers.controller';
import { AiTutorModule } from './ai-tutor/ai-tutor.module';
import { AdminSystemController } from './admin-system.controller';
import { AssessmentsModule } from './assessments/assessments.module';
import { AuditController } from './audit.controller';
import { BillingModule } from './billing/billing.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ReferralsModule } from './referrals/referrals.module';
import { MessagingModule } from './messaging/messaging.module';
import { PaymentConnectionsModule } from './payment-connections/payment-connections.module';
import { CertificatesModule } from './certificates/certificates.module';
import { CommunityModule } from './community/community.module';
import { CoursesController } from './courses.controller';
import { CoursesErrorFilter } from './courses-error.filter';
import { FormadorStatsController } from './formador-stats.controller';
import { LearningController } from './learning.controller';
import { LessonUnlockNotifierWorker } from './lesson-unlock-notifier.worker';
import { LearningPathsController, LearningPathsMeController } from './learning-paths.controller';
import { LearningErrorFilter } from './learning-error.filter';
import { ModuleAccessInterceptor } from './module-access.interceptor';
import { ModuleContextFactory } from './module-context.factory';
import { ModuleRegistryService } from './module-registry.service';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxQueueService } from './outbox-queue.service';
import { OutboxRecoveryWorker } from './outbox-recovery.worker';
import { ScormLearningBridge } from './scorm-learning.bridge';
import { StorageController } from './storage.controller';
import { StorageFileController } from './storage-file.controller';
import { TenantModulesService } from './tenant-modules.service';
import { TenantModulesErrorFilter } from './tenant-modules-error.filter';
import { EventsController } from './events.controller';
import { GroupsController } from './groups.controller';
import { AccessGroupsController } from './access-groups/access-groups.controller';
import { AccessGroupsService } from './access-groups/access-groups.service';
import { AccessGroupsCoursesBridge } from './access-groups/access-groups-courses.bridge';
import { AccessGroupsTiersBridge } from './access-groups/access-groups-tiers.bridge';
import { LeaderboardController } from './leaderboard.controller';
import { MeModulesController } from './me-modules.controller';
import { TenantSettingsController } from './tenant-settings.controller';
import { ThemingController } from './theming.controller';
import { ThemingErrorFilter } from './theming-error.filter';
import { ZoomLiveModule } from './zoom-live/zoom-live.module';
import { FundaeModule } from './fundae/fundae.module';
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
    forwardRef(() => ReferralsModule),
    forwardRef(() => MessagingModule),
    forwardRef(() => PaymentConnectionsModule),
    forwardRef(() => CommunityModule),
    forwardRef(() => CertificatesModule),
    forwardRef(() => AiTutorModule),
    forwardRef(() => AiGraderModule),
    forwardRef(() => AiContentModule),
  ],
  controllers: [
    CoursesController,
    LearningController,
    LearningPathsController,
    LearningPathsMeController,
    AuditController,
    FormadorStatsController,
    TenantSettingsController,
    ThemingController,
    AdminSystemController,
    StorageController,
    StorageFileController,
    AiProvidersController,
    // GET /me/modules — sidebar gating UI (módulos activos + capabilities EE).
    MeModulesController,
    LeaderboardController,
    GroupsController,
    EventsController,
    AccessGroupsController,
  ],
  providers: [
    ...outboxMetricsProviders,
    OutboxMetrics,
    OutboxQueueService,
    ModuleContextFactory,
    ModuleRegistryService,
    OutboxRecoveryWorker,
    LessonUnlockNotifierWorker,
    ScormLearningBridge,
    AccessGroupsService,
    AccessGroupsCoursesBridge,
    AccessGroupsTiersBridge,
    TenantModulesService,
    ModuleAccessInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: ModuleAccessInterceptor },
    { provide: APP_FILTER, useClass: CoursesErrorFilter },
    { provide: APP_FILTER, useClass: LearningErrorFilter },
    { provide: APP_FILTER, useClass: ThemingErrorFilter },
    { provide: APP_FILTER, useClass: TenantModulesErrorFilter },
  ],
  exports: [
    ModuleRegistryService,
    OutboxQueueService,
    ModuleContextFactory,
    TenantModulesService,
    ModuleAccessInterceptor,
    AccessGroupsService,
  ],
})
export class ModulesModule {}
