/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Global, Module } from '@nestjs/common';
import { isSanctionedGlobalAccess, tenantContextStorage } from '../tenancy/tenant-context.storage';
import {
  buildTenantScopedModelSet,
  createRlsEnforcementExtension,
  isInsidePrismaTransaction,
  markPrismaTransactionScope,
  resolveRlsEnforcementMode,
} from './rls-enforcement.extension';
import { RlsGapTelemetry } from './rls-gap-telemetry';
import { PrismaService } from './prisma.service';

/**
 * PrismaService se provee vía factory: cuando RLS_ENFORCEMENT != off, el
 * cliente inyectado es el EXTENDIDO con la extensión de enforcement (el proxy
 * de $extends reenvía onModuleInit/onModuleDestroy al subclass — verificado
 * empíricamente contra Prisma 5.22, ver rls-enforcement.extension.ts).
 */
@Global()
@Module({
  providers: [
    {
      provide: RlsGapTelemetry,
      useFactory: () => {
        const mode = resolveRlsEnforcementMode();
        return new RlsGapTelemetry(mode === 'on' ? 'on' : 'warn');
      },
    },
    {
      provide: PrismaService,
      inject: [RlsGapTelemetry],
      useFactory: (telemetry: RlsGapTelemetry): PrismaService => {
        const base = new PrismaService();
        const mode = resolveRlsEnforcementMode();
        if (mode === 'off') return base;
        const extended = base.$extends(
          createRlsEnforcementExtension({
            mode,
            getContext: () => tenantContextStorage.getStore(),
            tenantModels: buildTenantScopedModelSet(),
            onGap: (gap) => telemetry.record(gap),
            isSanctioned: () => isSanctionedGlobalAccess(),
            isInTransaction: () => isInsidePrismaTransaction(),
          }),
        ) as unknown as PrismaService;
        // $transaction del caller marcado con el scope: los hooks de sus
        // operaciones (lazy, ejecutan DENTRO de la llamada) ven la marca y no
        // envuelven — envolver las sacaría de la transacción (ver extensión).
        return new Proxy(extended, {
          get(target, prop) {
            if (prop === '$transaction') {
              const original = Reflect.get(target, prop, target) as (
                ...args: unknown[]
              ) => Promise<unknown>;
              return (...args: unknown[]) =>
                markPrismaTransactionScope(() => original.apply(target, args));
            }
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function'
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      },
    },
  ],
  exports: [PrismaService, RlsGapTelemetry],
})
export class PrismaModule {}
