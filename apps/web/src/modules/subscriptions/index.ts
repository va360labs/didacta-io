/// Extension point del módulo `mod.subscriptions` hacia el core.
///
/// `mod.subscriptions` no aporta sidebar items: la única superficie es
/// `/cuenta/suscripciones`, página personal del usuario que cuelga del
/// popup del avatar (no del sidebar). El entry sigue declarándose para
/// que `filterByActiveModulesOptional` reconozca el módulo.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const subscriptionsExtension: ModuleWebExtension = {
  name: 'mod.subscriptions',
};

export {
  subscriptionsApi,
  formatAmount,
  formatInterval,
  type SubscriptionStatus,
  type InvoiceStatus,
  type SubscriptionRow,
  type InvoiceRow,
  type StartSubscriptionBody,
  type StartSubscriptionResult,
} from './client';
