/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Global, Module } from '@nestjs/common';
import { tenantContextStorage } from '../tenancy/tenant-context.storage';
import {
  buildTenantScopedModelSet,
  createRlsEnforcementExtension,
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
        return base.$extends(
          createRlsEnforcementExtension({
            mode,
            getContext: () => tenantContextStorage.getStore(),
            tenantModels: buildTenantScopedModelSet(),
            onGap: (gap) => telemetry.record(gap),
          }),
        ) as unknown as PrismaService;
      },
    },
  ],
  exports: [PrismaService, RlsGapTelemetry],
})
export class PrismaModule {}
