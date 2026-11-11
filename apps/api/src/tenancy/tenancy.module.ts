/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscriptionGateInterceptor } from './subscription-gate.interceptor';
import { SubscriptionGateService } from './subscription-gate.service';
import { SuperAdminPrismaService } from './super-admin-prisma.service';
import { TenantContextService } from './tenant-context.service';
import { TenancyController } from './tenancy.controller';
import { TenantMiddleware } from './tenant.middleware';
import { TenantPrismaService } from './tenant-prisma.service';
import { TenantResolverService } from './tenant-resolver.service';

@Global()
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [TenancyController],
  providers: [
    TenantContextService,
    TenantMiddleware,
    TenantResolverService,
    TenantPrismaService,
    SuperAdminPrismaService,
    SubscriptionGateService,
    SubscriptionGateInterceptor,
    // Puerta de suscripción: 402 al contenido de un aula en pausa. Global, como
    // los interceptores de estado de cuenta y de sanciones (ver el fichero).
    { provide: APP_INTERCEPTOR, useExisting: SubscriptionGateInterceptor },
  ],
  exports: [
    TenantContextService,
    TenantResolverService,
    TenantPrismaService,
    SuperAdminPrismaService,
    SubscriptionGateService,
  ],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('{*path}');
  }
}
