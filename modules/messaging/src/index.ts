/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';
import type { MessagingService } from './messaging.service.js';

export { manifest };
export {
  ConversationNotFoundError,
  MessageBodyInvalidError,
  MessagingError,
  NotParticipantError,
  SelfDmError,
  SpaceNotFoundError,
  StaffFacultyError,
  TargetUserNotFoundError,
} from './errors.js';
export {
  MESSAGE_MAX_LENGTH,
  MESSAGING_EVENT,
  MESSAGING_STAFF_ROLES,
  MessagingService,
  type ConversationType,
  type ConversationView,
  type MessagesPage,
  type MessageView,
  type MessagingCaller,
  type MessagingEventPublisher,
  type MessagingPublicUser,
  type MessagingSpaceSummary,
  type MessagingSpacesLookup,
  type MessagingStaffLookup,
  type MessagingUsersLookup,
  type SendResult,
} from './messaging.service.js';

export function buildMessagingModule(_service: MessagingService): DidactaModule {
  return {
    manifest,
    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.messaging: onRegister', { name: manifest.name });
    },
    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.messaging: onEnable', { tenantId });
    },
    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.messaging: onDisable', { tenantId });
    },
    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.messaging: onUninstall', { tenantId });
    },
  };
}
