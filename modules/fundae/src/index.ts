import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { FundaeService } from './fundae.service.js';
export { buildActionXml } from './xml-export.js';
export {
  actionStatusSchema,
  createActionSchema,
  createBlockSchema,
  modalidadSchema,
  updateActionSchema,
  updateBlockSchema,
  type ActionStatus,
  type ActionView,
  type BlockView,
  type CreateActionDto,
  type CreateBlockDto,
  type Modalidad,
  type UpdateActionDto,
  type UpdateBlockDto,
} from './dto.js';
export {
  ActionNotFoundError,
  BlockHoursExceedActionError,
  BlockNotFoundError,
  BlockOrdinalDuplicadoError,
  CodigoDuplicadoError,
  CourseNotInTenantError,
  FechasInvalidasError,
  FundaeError,
} from './errors.js';

export const fundaeModule: DidactaModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.fundae: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.fundae: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.fundae: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.fundae: onUninstall', { tenantId });
  },
};
