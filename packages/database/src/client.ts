/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PrismaClient } from '@prisma/client';

/**
 * Crea una instancia de PrismaClient con configuración estándar.
 * Usado por `apps/api` y workers. NO usar directamente en código de módulos:
 * los módulos reciben el cliente vía `ModuleContext` o servicios del core.
 */
export function createPrismaClient(options?: { logQueries?: boolean }): PrismaClient {
  return new PrismaClient({
    log: options?.logQueries ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'],
  });
}

export { PrismaClient, Prisma } from '@prisma/client';

/// Re-exports de model types y enums generados por Prisma. Permite que
/// el código consuma los tipos sin importar directamente de
/// `@prisma/client` — toda la dependencia con Prisma queda encapsulada
/// en este package. Los modelos y enums se añaden conforme los consume
/// el resto del repo.
export type { InstalledModule } from '@prisma/client';
export type {
  InstalledModuleSource,
  InstalledModuleStatus,
  InstalledModuleVendor,
} from '@prisma/client';
