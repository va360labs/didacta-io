import { stripe, log, loadState, sleep, bt } from './lib2.mjs';
import { venta } from './10-venta-unica.mjs';
const s = loadState();
const C = s.creador_ES;
const B = (id, o) => bt(stripe, id, o);
const bal = async (acct) => {
  const b = await stripe('GET', '/v1/balance', {}, acct ? { account: acct } : {});
  return {
    available: b.available.map((x) => `${x.amount} ${x.currency}`),
    pending: b.pending.map((x) => `${x.amount} ${x.currency}`),
  };
};
const S = () => loadState();

// 3a) Reembolso total + reversión total de la transferencia
{
  await venta({ label: 'reemb_total', pm: 'pm_card_es' });
  const t = S().t_reemb_total;
  const ref = await stripe('POST', '/v1/refunds', { charge: t.charge }, { soft: true });
  const rev = await stripe(
    'POST',
    `/v1/transfers/${t.transfer}/reversals`,
    { amount: t.paraCreador, description: 'reembolso total' },
    { soft: true },
  );
  log('3a reembolso total', {
    refund: ref.__error
      ? ref.__error.message
      : {
          id: ref.id,
          status: ref.status,
          amount: ref.amount,
          bt: await B(ref.balance_transaction),
        },
    reversion: rev.__error
      ? { error: rev.__error.message, code: rev.__error.code }
      : { id: rev.id, amount: rev.amount, bt: await B(rev.balance_transaction) },
    plataforma_queda:
      ref.__error || rev.__error ? null : t.bruto - t.fee - t.paraCreador - t.bruto + t.paraCreador,
  });
}
// 3b) Reembolso parcial 40 % + reversión proporcional
{
  await venta({ label: 'reemb_parcial', pm: 'pm_card_es' });
  const t = S().t_reemb_parcial;
  const ref = await stripe(
    'POST',
    '/v1/refunds',
    { charge: t.charge, amount: 4000 },
    { soft: true },
  );
  const prop = Math.round((t.paraCreador * 4000) / t.bruto);
  const rev = await stripe(
    'POST',
    `/v1/transfers/${t.transfer}/reversals`,
    { amount: prop, description: 'reembolso parcial 40 %' },
    { soft: true },
  );
  log('3b reembolso parcial', {
    refund: ref.__error
      ? ref.__error.message
      : {
          id: ref.id,
          status: ref.status,
          amount: ref.amount,
          bt: await B(ref.balance_transaction),
        },
    reversion: rev.__error
      ? { error: rev.__error.message, code: rev.__error.code }
      : { id: rev.id, amount: rev.amount, bt: await B(rev.balance_transaction) },
    proporcional: prop,
  });
}
// 3c) Reembolso con refund[reverse_transfer]=true en SCT (¿se admite?)
{
  await venta({ label: 'reemb_rt', pm: 'pm_card_es' });
  const t = S().t_reemb_rt;
  const ref = await stripe(
    'POST',
    '/v1/refunds',
    { charge: t.charge, reverse_transfer: true },
    { soft: true },
  );
  log(
    '3c refund reverse_transfer=true en SCT',
    ref.__error
      ? { error: ref.__error.message }
      : { id: ref.id, status: ref.status, transfer_reversal: ref.transfer_reversal },
  );
  const tr = await stripe('GET', '/v1/transfers/' + t.transfer);
  log('3c transferencia tras refund', { amount: tr.amount, amount_reversed: tr.amount_reversed });
}
log('saldos tras reembolsos', { plataforma: await bal(), creador: await bal(C) });

// 4) Disputa
{
  await venta({ label: 'disputa', pm: 'pm_card_createDispute' });
  const t = S().t_disputa;
  let d = null;
  for (let i = 0; i < 20 && !d; i++) {
    await sleep(2000);
    const ds = await stripe('GET', '/v1/disputes', { charge: t.charge });
    d = ds.data[0];
  }
  if (!d) {
    log('4 disputa', 'no apareció');
  } else {
    const bts = [];
    for (const b of d.balance_transactions) bts.push(await B(b.id));
    log('4 disputa', { id: d.id, status: d.status, reason: d.reason, amount: d.amount, bts });
    const rev = await stripe(
      'POST',
      `/v1/transfers/${t.transfer}/reversals`,
      { amount: t.paraCreador, description: 'disputa ' + d.id },
      { soft: true },
    );
    log(
      '4 reversión por disputa',
      rev.__error
        ? { error: rev.__error.message, code: rev.__error.code }
        : { id: rev.id, amount: rev.amount, bt: await B(rev.balance_transaction) },
    );
    const fee_disputa = bts.reduce((a, b) => a + b.fee, 0);
    log('4 resultado', {
      plataforma_pierde_si_no_repercute:
        t.bruto - t.fee - t.paraCreador - d.amount - fee_disputa + (rev.__error ? 0 : rev.amount),
      nota: 'comisión 5 € + cobro 100 − fee − transfer; −100 disputa − tasa; + reversión',
    });
    s.disputa = d.id;
  }
}
log('saldos finales', { plataforma: await bal(), creador: await bal(C) });
