import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { ReferralsController } from './referrals.controller';
import { ReferralsErrorFilter } from './referrals-error.filter';
import { ReferralsSubscriptionsBridge } from './referrals-subscriptions.bridge';
import { ReferralsNotificationsBridge } from './referrals-notifications.bridge';
import { ReferralsApprovalWorker } from './referrals-approval.worker';

/// Backend del módulo `mod.referrals`. Encapsula el controller (miembro +
/// track público + admin), el filter de errores de dominio, el bridge que
/// consume los eventos de mod.subscriptions (atribución + devengo) y el
/// worker BullMQ que aprueba comisiones al vencer la garantía.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [ReferralsController],
  providers: [
    ReferralsSubscriptionsBridge,
    ReferralsNotificationsBridge,
    ReferralsApprovalWorker,
    { provide: APP_FILTER, useClass: ReferralsErrorFilter },
  ],
})
export class ReferralsModule {}
