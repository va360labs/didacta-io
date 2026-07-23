import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsWebhookController } from './subscriptions-webhook.controller';
import { SubscriptionsErrorFilter } from './subscriptions-error.filter';
import { SubscriptionsLearningBridge } from './subscriptions-learning.bridge';
import { SubscriptionsGraceExpirationWorker } from './subscriptions-grace-expiration.worker';
import { MembershipPublicController } from './membership-public.controller';
import { MembershipAdminController } from './membership-admin.controller';
import { MembershipProvisioningService } from './membership-provisioning.service';
import { MembershipAccessGroupsBridge } from './membership-access-groups.bridge';

/// Backend del módulo `mod.subscriptions`. Encapsula los controllers
/// alumno + webhook idempotente, el filter, el bridge cross-module hacia
/// `mod.learning` (enroll/extend/revoke según evento de subscription) y el
/// worker BullMQ que cron-expira la gracia tras un fallo de pago.
///
/// Hermano de `mod.billing` — ambos comparten el `StripeAdapter` que vive
/// en `ModuleRegistryService` (core, infra compartida).
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [
    SubscriptionsController,
    SubscriptionsWebhookController,
    // Membresía (página pública /unete): venta de "acceso a todo" por
    // suscripción con planes parametrizables.
    MembershipPublicController,
    MembershipAdminController,
  ],
  providers: [
    SubscriptionsLearningBridge,
    SubscriptionsGraceExpirationWorker,
    MembershipProvisioningService,
    MembershipAccessGroupsBridge,
    { provide: APP_FILTER, useClass: SubscriptionsErrorFilter },
  ],
})
export class SubscriptionsModule {}
