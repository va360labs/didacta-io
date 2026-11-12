import { stripe, log, loadState } from './lib2.mjs';
import { venta } from './10-venta-unica.mjs';
const s = loadState();
const MX = s.creador_MX;
const a = await stripe('GET', '/v1/accounts/' + MX);
log('MX', {
  caps: a.capabilities,
  due: a.requirements?.currently_due,
  disabled: a.requirements?.disabled_reason,
});
// 1) SCT sin on_behalf_of: cobro en la plataforma (EUR) y transferencia a MX
await venta({ label: 'eur100_creador_MX', pm: 'pm_card_es', dest: MX });
// 2) SCT con on_behalf_of = MX (cobro en MXN)
await venta({
  label: 'mxn2000_obo_MX',
  amount: 200000,
  currency: 'mxn',
  pm: 'pm_card_mx',
  dest: MX,
  extra: { on_behalf_of: MX },
});
// 3) Destination charge sin y con on_behalf_of
for (const [k, extra] of Object.entries({
  dest_sin_obo: { transfer_data: { destination: MX }, application_fee_amount: 500 },
  dest_con_obo: {
    transfer_data: { destination: MX },
    application_fee_amount: 10000,
    on_behalf_of: MX,
  },
})) {
  const pi = await stripe(
    'POST',
    '/v1/payment_intents',
    {
      amount: k === 'dest_con_obo' ? 200000 : 10000,
      currency: k === 'dest_con_obo' ? 'mxn' : 'eur',
      payment_method: k === 'dest_con_obo' ? 'pm_card_mx' : 'pm_card_es',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      ...extra,
    },
    { soft: true },
  );
  log(
    'MX ' + k,
    pi.__error
      ? { error: pi.__error.message, code: pi.__error.code }
      : { id: pi.id, status: pi.status },
  );
}
// 4) Transferencia suelta desde saldo disponible
const tr = await stripe(
  'POST',
  '/v1/transfers',
  { amount: 1000, currency: 'eur', destination: MX },
  { soft: true },
);
log(
  'MX transferencia suelta',
  tr.__error ? { error: tr.__error.message, code: tr.__error.code } : { id: tr.id },
);
