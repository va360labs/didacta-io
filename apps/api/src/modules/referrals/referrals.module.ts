/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { ReferralsController } from './referrals.controller';
import { ReferralsErrorFilter } from './referrals-error.filter';
import { ReferralsSubscriptionsBridge } from './referrals-subscriptions.bridge';
import { ReferralsBillingBridge } from './referrals-billing.bridge';
import { ReferralsNotificationsBridge } from './referrals-notifications.bridge';
import { ReferralsApprovalWorker } from './referrals-approval.worker';

/// Backend del módulo `mod.referrals`. Encapsula el controller (miembro +
/// track público + admin), el filter de errores de dominio, los bridges que
/// consumen los eventos de mod.subscriptions y de mod.billing (atribución +
/// devengo de membresías y de compras sueltas) y el
/// worker BullMQ que aprueba comisiones al vencer la garantía.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [ReferralsController],
  providers: [
    ReferralsSubscriptionsBridge,
    ReferralsBillingBridge,
    ReferralsNotificationsBridge,
    ReferralsApprovalWorker,
    { provide: APP_FILTER, useClass: ReferralsErrorFilter },
  ],
})
export class ReferralsModule {}
