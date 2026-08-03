/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SuperAdminPrismaService } from './super-admin-prisma.service';
import { TenantContextService } from './tenant-context.service';
import { TenantMiddleware } from './tenant.middleware';
import { TenantPrismaService } from './tenant-prisma.service';
import { TenantResolverService } from './tenant-resolver.service';

@Global()
@Module({
  imports: [AuthModule, PrismaModule],
  providers: [
    TenantContextService,
    TenantMiddleware,
    TenantResolverService,
    TenantPrismaService,
    SuperAdminPrismaService,
  ],
  exports: [
    TenantContextService,
    TenantResolverService,
    TenantPrismaService,
    SuperAdminPrismaService,
  ],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('{*path}');
  }
}
