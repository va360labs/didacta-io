import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.subscriptions',
  displayName: 'Suscripciones recurrentes (Stripe)',
  description:
    'Suscripciones mensuales/anuales con Stripe. Maneja activación, grace period tras impago, dunning y cancelación. Se integra con mod.learning vía eventos.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_subscriptions_',
  permissions: [
    'subscriptions.subscription.read',
    'subscriptions.subscription.create',
    'subscriptions.subscription.cancel',
  ],
  dependencies: {
    modules: [
      { name: 'mod.learning', version: '^1.0.0' },
      { name: 'mod.courses', version: '^1.0.0' },
    ],
    optionalModules: [],
  },
  eventsEmitted: [
    'subscriptions.subscription.created',
    'subscriptions.subscription.activated',
    'subscriptions.subscription.past_due',
    'subscriptions.subscription.unpaid',
    'subscriptions.subscription.canceled',
    'subscriptions.invoice.paid',
    'subscriptions.invoice.payment_failed',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/subscriptions',
});
