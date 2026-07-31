/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  traceId: string;
  /**
   * true cuando el código ya corre dentro de una transacción que seteó el GUC
   * `app.current_tenant_id` (withTenantContext / asAdmin). La extensión de
   * enforcement de RLS lo lee para NO envolver esas operaciones otra vez.
   */
  gucApplied?: boolean;
}

/**
 * ALS único de proceso para el contexto de tenant.
 *
 * Vive fuera de TenantContextService para que la extensión del cliente Prisma
 * (que se instancia en la factory de PrismaModule, antes del grafo de DI)
 * pueda leer el contexto sin acoplar PrismaModule a TenancyModule.
 */
export const tenantContextStorage = new AsyncLocalStorage<TenantContext>();
