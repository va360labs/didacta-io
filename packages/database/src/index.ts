/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

export { createPrismaClient, PrismaClient, Prisma } from './client.js';
export type {
  InstalledModule,
  InstalledModuleSource,
  InstalledModuleStatus,
  InstalledModuleVendor,
  TenantDomainSurface,
  SubscriptionGateState,
  PayoutsAccountStatus,
  PayoutsSaleStatus,
  PayoutsSaleSourceKind,
  PayoutsLedgerEntryType,
  PayoutsDebtReason,
  PayoutsDebtStatus,
  PayoutsRefundReversalStatus,
} from './client.js';
export { withTenantContext } from './tenant-context.js';
