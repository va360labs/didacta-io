import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  traceId: string;
}

/**
 * Storage por request usando AsyncLocalStorage.
 * Permite que cualquier service del backend lea el tenantId del request actual
 * sin tener que pasarlo como parámetro a cada función.
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantContext>();

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
