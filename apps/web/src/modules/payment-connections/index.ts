/// Extension point del módulo `mod.payment-connections` hacia el core.
///
/// Registra un item de sidebar en "Administración" que apunta a la página host
/// `/admin/integraciones/payment-connections` (solo super_admin). La UI es una
/// página directa del host (patrón billing/products): los módulos built-in no
/// tienen ZIP, así que no aplica `loadModuleUI`/ModuleAssetsController. Cuando
/// exista un loader genérico de surfaces built-in, esta UI se moverá a
/// `modules/payment-connections/src/ui/` (deuda documentada en el PRD/ADR).

import type { ModuleWebExtension } from '@/lib/module-registry';

export const paymentConnectionsExtension: ModuleWebExtension = {
  name: 'mod.payment-connections',
  sidebarItems: [
    {
      group: 'Administración',
      href: '/admin/integraciones/payment-connections',
      label: 'Conexiones de pago',
      icon: 'briefcase',
      requiresRole: 'super_admin',
    },
  ],
};

export {
  paymentConnectionsApi,
  formatAmount,
  stripeSubscriptionUrl,
  type PaymentConnection,
  type PaymentConnectionStatus,
  type StripeSubscriber,
  type DidactaUserLite,
  type ReconcileResult,
  type InviteResultRow,
  type InviteOutcome,
} from '@/lib/payment-connections';
