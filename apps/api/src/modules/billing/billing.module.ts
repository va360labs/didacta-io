import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { BillingController } from './billing.controller';
import { BillingAdminController } from './billing-admin.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingErrorFilter } from './billing-error.filter';
import { BillingLearningBridge } from './billing-learning.bridge';

/// Backend del módulo `mod.billing`. Encapsula los controllers de checkout
/// alumno, admin de productos Stripe, webhook idempotente, el filter y el
/// bridge cross-module que enrolla en `mod.learning` cuando una orden se
/// confirma como COMPLETED.
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
  controllers: [BillingController, BillingAdminController, BillingWebhookController],
  providers: [BillingLearningBridge, { provide: APP_FILTER, useClass: BillingErrorFilter }],
})
export class BillingModule {}
