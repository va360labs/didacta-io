import { stripe, log, loadState } from './lib2.mjs';
const s = loadState();
const r = await stripe(
  'POST',
  '/v1/balance_settings',
  {
    payments: {
      payouts: {
        minimum_balance_by_currency: { eur: 10000 },
        schedule: { interval: 'weekly', weekly_payout_days: ['monday'] },
      },
    },
  },
  { account: s.creador_ES2, soft: true },
);
log('colchón mínimo + semanal (ES2)', r.__error ? { error: r.__error.message } : r.payments);
const bal = async (acct) => {
  const b = await stripe('GET', '/v1/balance', {}, acct ? { account: acct } : {});
  return {
    available: b.available.map((x) => `${x.amount} ${x.currency}`),
    pending: b.pending.map((x) => `${x.amount} ${x.currency}`),
    connect_reserved: b.connect_reserved?.map((x) => `${x.amount} ${x.currency}`),
  };
};
log('saldo plataforma', await bal());
for (const c of ['ES', 'ES2', 'US', 'GB', 'MX'])
  log('saldo creador ' + c + ' ' + s['creador_' + c], await bal(s['creador_' + c]));
// disputa: estado final
const d = await stripe('GET', '/v1/disputes/' + (s.disputa ?? ''), {}, { soft: true });
if (!d.__error) log('disputa', { id: d.id, status: d.status });
const ds = await stripe('GET', '/v1/disputes', { limit: 3 });
log(
  'disputas recientes',
  ds.data.map((x) => ({ id: x.id, charge: x.charge, status: x.status, amount: x.amount })),
);
