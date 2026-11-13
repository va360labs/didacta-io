import { stripe, log } from './lib.mjs';
import { load } from './c-lib.mjs';
const s = load();
const cs = await stripe('GET', '/v1/checkout/sessions/' + s.sessionId);
log('session', {
  id: cs.id.slice(0, 20) + '…',
  status: cs.status,
  payment_status: cs.payment_status,
  amount_total: cs.amount_total,
  pi: cs.payment_intent,
  success_url: cs.success_url,
  metadata: cs.metadata,
  client_reference_id: cs.client_reference_id,
});
