import { stripe, log, loadState } from './lib2.mjs';
const s = loadState();
for (const c of process.argv.slice(2)) {
  const a = await stripe('GET', '/v1/accounts/' + s['creador_' + c]);
  log(c, {
    id: a.id,
    caps: a.capabilities,
    due: a.requirements?.currently_due,
    eventually: a.requirements?.eventually_due,
    disabled: a.requirements?.disabled_reason,
    charges_enabled: a.charges_enabled,
    payouts_enabled: a.payouts_enabled,
    details_submitted: a.details_submitted,
    tos: a.tos_acceptance?.service_agreement,
    payouts: a.settings?.payouts?.schedule,
  });
}
