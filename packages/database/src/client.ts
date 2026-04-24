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

export { PrismaClient } from '@prisma/client';
export type { Prisma } from '@prisma/client';
