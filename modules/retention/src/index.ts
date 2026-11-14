/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, DomainEvent, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';
import type { RetentionService } from './retention.service.js';

export { manifest };
export * from './errors.js';
export * from './ports.js';
export * from './variables.js';
export {
  RETENTION_TEMPLATES,
  findTemplate,
  type RetentionTemplate,
  type RetentionTemplateCopy,
  type RetentionTemplateKey,
} from './templates.js';
export {
  isValidTimeZone,
  isWithinWindow,
  localDayKey,
  nextDayWindowStart,
  nextWindowStart,
  type SendWindow,
} from './schedule.js';
export {
  activityReference,
  anniversaryOccurrences,
  daysAfterJoinOccurrences,
  inactiveOccurrences,
  welcomeOccurrences,
  type Occurrence,
} from './occurrences.js';
export {
  MESSAGE_BODY_MAX,
  RETENTION_DEFAULTS,
  RETENTION_EVENT,
  RETENTION_MODULE,
  RetentionService,
  type AtRiskQuery,
  type AtRiskReason,
  type AtRiskReasonKind,
  type AtRiskRow,
  type AtRiskView,
  type AutomationInput,
  type AutomationPatch,
  type AutomationStats,
  type AutomationView,
  type PreviewInput,
  type PreviewView,
  type RetentionEventPublisher,
  type RetentionLogger,
  type RetentionSettingsPatch,
  type RetentionSettingsView,
  type RunStats,
  type TemplateView,
} from './retention.service.js';

interface CourseCompletedPayload {
  userId: string;
  courseId: string;
}

interface PostCreatedPayload {
  postId: string;
  authorId: string;
}

interface LevelChangedPayload {
  userId: string;
  to: string;
  levelName?: string;
}

/**
 * Módulo cableado con su servicio. Se suscribe en su propio `onRegister` a los
 * eventos que declara en `eventsConsumed` (ADR-039, regla 5), como hace
 * mod.certificates, en vez de con un puente nuevo en el host.
 *
 * Los handlers solo encolan (una fila idempotente); el envío lo hace el
 * barrido. Si fallan, relanzan: el outbox reintenta y la clave única impide
 * que el reintento duplique nada.
 */
export function buildRetentionModule(service: RetentionService): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.retention: onRegister', { name: manifest.name });

      ctx.eventBus.subscribe<CourseCompletedPayload>(
        'learning.course.completed',
        async (event: DomainEvent<CourseCompletedPayload>) => {
          const { userId, courseId } = event.data;
          if (!userId || !courseId) return;
          await service.onCourseCompleted(event.metadata.tenantId, userId, courseId);
        },
      );

      ctx.eventBus.subscribe<PostCreatedPayload>(
        'community.post.created',
        async (event: DomainEvent<PostCreatedPayload>) => {
          const { authorId, postId } = event.data;
          if (!authorId || !postId) return;
          await service.onPostCreated(event.metadata.tenantId, authorId, postId);
        },
      );

      ctx.eventBus.subscribe<LevelChangedPayload>(
        'gamification.level.changed',
        async (event: DomainEvent<LevelChangedPayload>) => {
          const { userId, to, levelName } = event.data;
          if (!userId || !to) return;
          await service.onLevelChanged(event.metadata.tenantId, userId, to, levelName ?? to);
        },
      );
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.retention: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.retention: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.retention: onUninstall', { tenantId });
    },
  };
}
