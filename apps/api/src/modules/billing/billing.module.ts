/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { BillingController } from './billing.controller';
import { BillingAdminController } from './billing-admin.controller';
import { BillingPublicController } from './billing-public.controller';
import { BillingProvisioningService } from './billing-provisioning.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingErrorFilter } from './billing-error.filter';
import { BillingLearningBridge } from './billing-learning.bridge';
import { BillingRefundBridge } from './billing-refund.bridge';

/// Backend del módulo `mod.billing`. Encapsula los controllers de checkout
/// alumno, el público del catálogo de venta (viaje 2: tenant por Host, sin
/// JWT), admin de productos Stripe, webhook idempotente, el filter, el
/// provisioning del comprador anónimo y los bridges cross-module hacia
/// `mod.learning` (matrícula al completar la orden, retirada al reembolsar).
///
/// Comparte el `StripeAdapter` con `mod.subscriptions` — el adapter vive en
/// `ModuleRegistryService` (core, infra compartida). Los dos módulos
/// pueden migrarse independiente, pero coordinarse cuando el adapter
/// cambie evita rotura cruzada.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule
/// para romper el ciclo a través de ModuleRegistryService.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [
    BillingController,
    BillingPublicController,
    BillingAdminController,
    BillingWebhookController,
  ],
  providers: [
    BillingLearningBridge,
    BillingRefundBridge,
    BillingProvisioningService,
    { provide: APP_FILTER, useClass: BillingErrorFilter },
  ],
  // El webhook de mod.subscriptions hace fan-out a billing (una sola cuenta de
  // Stripe alimenta ambos módulos) y necesita el mismo provisioner.
  exports: [BillingProvisioningService],
})
export class BillingModule {}
