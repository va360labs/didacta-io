/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';
import { HelloWorldService } from './service.js';

/**
 * Implementación del contrato `DidactaModule` para mod.hello-world.
 * El lifecycle lo define el contrato `DidactaModule` de @didacta/core-kernel.
 */
export const helloWorldModule: DidactaModule = {
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
