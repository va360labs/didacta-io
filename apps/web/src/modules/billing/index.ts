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
      group: 'Facturación',
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
  type StartCheckoutResult,
  type BillingProduct,
  type BillingProductsListResponse,
  type BillingProductResponse,
} from './client';
