/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { tenantContextStorage, type TenantContext } from './tenant-context.storage';

export type { TenantContext } from './tenant-context.storage';

/**
 * Storage por request usando AsyncLocalStorage.
 * Permite que cualquier service del backend lea el tenantId del request actual
 * sin tener que pasarlo como parámetro a cada función.
 *
 * El ALS subyacente vive en tenant-context.storage.ts (singleton de proceso)
 * para que la extensión RLS del cliente Prisma pueda leerlo sin DI.
 */
@Injectable()
export class TenantContextService {
  private readonly als = tenantContextStorage;

  run<T>(ctx: TenantContext, fn: () => Promise<T> | T): Promise<T> | T {
    return this.als.run(ctx, fn);
  }

  get(): TenantContext | undefined {
    return this.als.getStore();
  }

  /** Helper que falla si se llama fuera de un request con tenant. */
  require(): TenantContext {
    const ctx = this.als.getStore();
    if (!ctx) {
      throw new Error(
        'TenantContext no disponible. Verifica que el request pasa por TenantMiddleware.',
      );
    }
    return ctx;
  }
}
