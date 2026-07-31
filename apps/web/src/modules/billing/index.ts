/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.billing` hacia el core.
///
/// El catálogo `apps/web/src/modules/index.ts` importa esta constante y la
/// agrega al `moduleExtensions[]`. Aporta el sidebar item de
/// `/admin/billing/products` (grupo Facturación, requiresRole tenant_admin).

import type { ModuleWebExtension } from '@/lib/module-registry';

export const billingExtension: ModuleWebExtension = {
  name: 'mod.billing',
  sidebarItems: [
    {
      group: 'Ingresos',
      href: '/admin/billing/products',
      label: 'Productos (Stripe)',
      icon: 'package',
      requiresRole: 'tenant_admin',
    },
  ],
};

export {
  billingApi,
  formatPrice,
  getCourseOffer,
  type StartCheckoutResult,
  type BillingProduct,
  type BillingProductsListResponse,
  type BillingProductResponse,
  type CourseOffer,
  type CourseOfferOption,
} from './client';
