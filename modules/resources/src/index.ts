import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export {
  DEFAULT_COLLECTIONS,
  RESOURCES_EVENT,
  ResourcesService,
  type CollectionView,
  type CreateResourceInput,
  type ResourceKindValue,
  type ResourceView,
  type ResourcesEventPublisher,
} from './resources.service.js';
export { ResourcesError, ResourcesNotFoundError, ResourcesValidationError } from './errors.js';

/** Módulo mod.resources (bloque 4 — biblioteca de recursos por colecciones). */
export function buildResourcesModule(): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.resources: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.resources: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.resources: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.resources: onUninstall', { tenantId });
    },
  };
}
