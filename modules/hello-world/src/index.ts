import type { LearnShipModule, ModuleContext } from '@learnship/core-kernel';
import { manifest } from './manifest.js';
import { HelloWorldService } from './service.js';

/**
 * Implementación del contrato `LearnShipModule` para mod.hello-world.
 * Ver docs/ARQUITECTURA-MODULAR.md §6 para detalles del lifecycle.
 */
export const helloWorldModule: LearnShipModule = {
  manifest,

  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('hello-world: onRegister', { name: manifest.name });
    // En un módulo real: registrar handlers globales de eventos, hooks expuestos.
  },

  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('hello-world: onEnable', { tenantId });
    // En un módulo real: aplicar migraciones, sembrar datos iniciales.
  },

  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('hello-world: onDisable', { tenantId });
    // En un módulo real: cancelar jobs pendientes, desactivar endpoints.
  },

  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('hello-world: onUninstall', { tenantId });
    // En un módulo real: archivar datos del tenant (no borrar por defecto).
  },
};

export { manifest, HelloWorldService };
