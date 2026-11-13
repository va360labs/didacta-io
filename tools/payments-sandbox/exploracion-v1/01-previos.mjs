import { stripe, log } from './lib.mjs';
const fees = await stripe('GET', '/v1/application_fees', { limit: 10 });
for (const f of fees.data)
  log('fee', {
    id: f.id,
    amount: f.amount,
    currency: f.currency,
    account: f.account,
    charge: f.charge,
    originating_transaction: f.originating_transaction,
    refunded: f.refunded,
    amount_refunded: f.amount_refunded,
    created: new Date(f.created * 1000).toISOString(),
  });
const list = await stripe('GET', '/v1/accounts', { limit: 20 });
for (const a of list.data)
  log('cuenta', {
    id: a.id,
    type: a.type,
    controller: a.controller,
    capabilities: a.capabilities,
    charges_enabled: a.charges_enabled,
    payouts_enabled: a.payouts_enabled,
    details_submitted: a.details_submitted,
    email: a.email ? '(tiene)' : null,
    metadata: a.metadata,
    due: a.requirements?.currently_due?.slice(0, 8),
    disabled_reason: a.requirements?.disabled_reason,
  });
