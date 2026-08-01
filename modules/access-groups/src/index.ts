/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Punto de entrada del módulo mod.access-groups.
 *
 * Exporta:
 *   - manifest declarativo (parseado).
 *   - DTOs Zod del CRUD de grupos + slugify.
 *   - Semántica portable del `source` de las membresías (MANUAL sticky,
 *     bridges que solo retiran lo suyo).
 *   - Factory `buildAccessGroupsModule()` para registrar contra el
 *     ModuleRegistry del CORE.
 *
 * La orquestación NestJS (controller, service Prisma y bridges) vive en el
 * host: apps/api/src/modules/access-groups/ (ADR-011/015).
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };

export {
  ACCESS_GROUP_KINDS,
  assignAccessGroupMembersSchema,
  createAccessGroupSchema,
  setAccessGroupCoursesSchema,
  slugify,
  updateAccessGroupSchema,
} from './dto.js';
export type {
  AccessGroupKindDto,
  AssignAccessGroupMembersDto,
  CreateAccessGroupDto,
  SetAccessGroupCoursesDto,
  UpdateAccessGroupDto,
} from './dto.js';

export {
  ACCESS_GROUP_MEMBER_SOURCES,
  bridgeMayRevoke,
  planMemberActivation,
} from './member-source.js';
export type {
  AccessGroupBridgeSource,
  AccessGroupMemberSource,
  ExistingMembership,
  MemberActivationPlan,
} from './member-source.js';

export function buildAccessGroupsModule(): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.access-groups: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.access-groups: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.access-groups: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.access-groups: onUninstall', { tenantId });
    },
  };
}
