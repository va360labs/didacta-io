import { stripe, log, loadState, sleep, bt } from './lib2.mjs';
import { venta } from './10-venta-unica.mjs';
const s = loadState();
const C2 = s.creador_ES2;
const B = (id, o) => bt(stripe, id, o);
const bal = async (acct) => {
  const b = await stripe('GET', '/v1/balance', {}, acct ? { account: acct } : {});
  return {
    available: b.available.map((x) => `${x.amount} ${x.currency}`),
    pending: b.pending.map((x) => `${x.amount} ${x.currency}`),
  };
};
const a = await stripe('GET', '/v1/accounts/' + C2);
log('ES2', {
  caps: a.capabilities,
  due: a.requirements?.currently_due,
  payouts: a.settings?.payouts,
});

// A) Control del calendario por la plataforma (cuenta con panel Express y pérdidas = Stripe)
for (const [k, p] of Object.entries({
  v1_manual: [
    'POST',
    '/v1/accounts/' + C2,
    { settings: { payouts: { schedule: { interval: 'manual' } } } },
    {},
  ],
  v1_weekly: [
    'POST',
    '/v1/accounts/' + C2,
    { settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'monday' } } } },
    {},
  ],
  v1_delay14: [
    'POST',
    '/v1/accounts/' + C2,
    { settings: { payouts: { schedule: { delay_days: 14 } } } },
    {},
  ],
  bs_get: ['GET', '/v1/balance_settings', {}, { account: C2 }],
  bs_delay14: [
    'POST',
    '/v1/balance_settings',
    { payments: { settlement_timing: { delay_days_override: 14 } } },
    { account: C2 },
  ],
  bs_monthly: [
    'POST',
    '/v1/balance_settings',
    { payments: { payouts: { schedule: { interval: 'monthly', monthly_payout_days: [1] } } } },
    { account: C2 },
  ],
  bs_manual: [
    'POST',
    '/v1/balance_settings',
    { payments: { payouts: { schedule: { interval: 'manual' } } } },
    { account: C2 },
  ],
  bs_nodebit: [
    'POST',
    '/v1/balance_settings',
    { payments: { debit_negative_balances: false } },
    { account: C2 },
  ],
})) {
  const r = await stripe(p[0], p[1], p[2], { ...p[3], soft: true });
  log(
    'calendario ' + k,
    r.__error
      ? { error: r.__error.message }
      : r.object === 'balance_settings'
        ? r.payments
        : r.settings?.payouts,
  );
}
// B) Venta con fondos disponibles al instante -> transfer -> payout del creador -> reembolso + intento de reversión
await venta({ label: 'pagado_luego_reembolso', pm: 'pm_card_bypassPending', dest: C2 });
const t = loadState().t_pagado_luego_reembolso;
await sleep(2000);
log('saldo ES2 tras transfer', await bal(C2));
const b2 = await stripe('GET', '/v1/balance', {}, { account: C2 });
const disp = b2.available.find((x) => x.currency === 'eur')?.amount ?? 0;
const po = await stripe(
  'POST',
  '/v1/payouts',
  { amount: disp, currency: 'eur' },
  { account: C2, soft: true },
);
log(
  'payout del creador',
  po.__error
    ? { error: po.__error.message }
    : {
        id: po.id,
        amount: po.amount,
        status: po.status,
        arrival: new Date(po.arrival_date * 1000).toISOString().slice(0, 10),
      },
);
await sleep(2000);
log('saldo ES2 tras payout', await bal(C2));
const ref = await stripe('POST', '/v1/refunds', { charge: t.charge }, { soft: true });
log(
  'reembolso al alumno',
  ref.__error
    ? { error: ref.__error.message }
    : { id: ref.id, status: ref.status, bt: await B(ref.balance_transaction) },
);
const rev = await stripe(
  'POST',
  `/v1/transfers/${t.transfer}/reversals`,
  { amount: t.paraCreador },
  { soft: true },
);
log(
  'reversión con el creador ya pagado (pérdidas = Stripe)',
  rev.__error
    ? { error: rev.__error.message, code: rev.__error.code }
    : { id: rev.id, amount: rev.amount, bt: await B(rev.balance_transaction) },
);
log('saldos', { plataforma: await bal(), creador: await bal(C2) });
// C) Reversión parcial dentro del saldo
const rev2 = await stripe(
  'POST',
  `/v1/transfers/${t.transfer}/reversals`,
  { amount: 100 },
  { soft: true },
);
log(
  'reversión de 1 € con saldo 0',
  rev2.__error ? { error: rev2.__error.message, code: rev2.__error.code } : { id: rev2.id },
);
// D) Adeudo directo a la cuenta conectada (account debit)
const deb = await stripe(
  'POST',
  '/v1/charges',
  { amount: 2340, currency: 'eur', source: C2, description: 'repercutir tasa de disputa' },
  { soft: true },
);
log(
  'account debit',
  deb.__error ? { error: deb.__error.message, code: deb.__error.code } : { id: deb.id },
);
