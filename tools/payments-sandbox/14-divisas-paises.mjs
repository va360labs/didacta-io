import { stripe, log, loadState, saveState, sleep, bt } from './lib2.mjs';
import { venta } from './10-venta-unica.mjs';
const s = loadState();
const B = (id, o) => bt(stripe, id, o);
const bal = async (acct) => {
  const b = await stripe('GET', '/v1/balance', {}, acct ? { account: acct } : {});
  return {
    available: b.available.map((x) => `${x.amount} ${x.currency}`),
    pending: b.pending.map((x) => `${x.amount} ${x.currency}`),
  };
};
const paso = process.argv[2] ?? 'todo';

if (paso === 'todo' || paso === 'fee_disputa') {
  // Repercutir al creador la tasa de disputa + comisión perdida (23,40 €) revirtiendo parte de OTRA transferencia suya
  const t = s.t_unica100_tarjeta_US;
  const rev = await stripe(
    'POST',
    `/v1/transfers/${t.transfer}/reversals`,
    {
      amount: 2340,
      description: 'repercusión tasa de disputa du_… (20 €) + comisión Stripe no devuelta (3,40 €)',
    },
    { soft: true },
  );
  log(
    'repercutir tasa de disputa con reversión de otra transferencia',
    rev.__error
      ? { error: rev.__error.message }
      : { id: rev.id, amount: rev.amount, bt: await B(rev.balance_transaction) },
  );
}
if (paso === 'todo' || paso === 'fx') {
  // 5) Divisas con creador ES (sin on_behalf_of): la plataforma liquida en EUR
  await venta({ label: 'usd100_creador_ES', amount: 10000, currency: 'usd', pm: 'pm_card_visa' });
  await venta({ label: 'mxn2000_creador_ES', amount: 200000, currency: 'mxn', pm: 'pm_card_mx' });
  await venta({ label: 'brl500_creador_ES', amount: 50000, currency: 'brl', pm: 'pm_card_br' });
  await venta({ label: 'gbp100_creador_ES', amount: 10000, currency: 'gbp', pm: 'pm_card_gb' });
}
if (paso === 'todo' || paso === 'xb') {
  // Transfronterizo SIN on_behalf_of: creador US y GB
  await venta({ label: 'eur100_creador_US', pm: 'pm_card_es', dest: s.creador_US });
  await venta({
    label: 'usd100_creador_US',
    amount: 10000,
    currency: 'usd',
    pm: 'pm_card_visa',
    dest: s.creador_US,
  });
  await venta({
    label: 'usd100_creador_US_transfer_en_usd',
    amount: 10000,
    currency: 'usd',
    pm: 'pm_card_visa',
    dest: s.creador_US,
    transferCurrency: 'usd',
  });
  await venta({
    label: 'gbp100_creador_GB',
    amount: 10000,
    currency: 'gbp',
    pm: 'pm_card_gb',
    dest: s.creador_GB,
  });
  log('saldos creadores', { US: await bal(s.creador_US), GB: await bal(s.creador_GB) });
}
if (paso === 'todo' || paso === 'obo') {
  // CON on_behalf_of
  await venta({ label: 'eur100_obo_ES', pm: 'pm_card_es', extra: { on_behalf_of: s.creador_ES } });
  await venta({
    label: 'eur100_obo_ES_tarjetaUS',
    pm: 'pm_card_visa',
    extra: { on_behalf_of: s.creador_ES },
  });
  await venta({
    label: 'usd100_obo_US',
    amount: 10000,
    currency: 'usd',
    pm: 'pm_card_visa',
    dest: s.creador_US,
    extra: { on_behalf_of: s.creador_US },
  });
  await venta({
    label: 'usd100_obo_US_transfer_usd',
    amount: 10000,
    currency: 'usd',
    pm: 'pm_card_visa',
    dest: s.creador_US,
    extra: { on_behalf_of: s.creador_US },
    transferCurrency: 'usd',
  });
  await venta({
    label: 'gbp100_obo_GB',
    amount: 10000,
    currency: 'gbp',
    pm: 'pm_card_gb',
    dest: s.creador_GB,
    extra: { on_behalf_of: s.creador_GB },
  });
  await venta({
    label: 'eur100_obo_US',
    pm: 'pm_card_es',
    dest: s.creador_US,
    extra: { on_behalf_of: s.creador_US },
  });
  log('saldo plataforma', await bal());
}
if (paso === 'dest') {
  // Comparación: destination charge (a) y (b) con el creador ES
  for (const [k, extra] of Object.entries({
    a_app_fee: { application_fee_amount: 500, transfer_data: { destination: s.creador_ES } },
    b_transfer_amount: { transfer_data: { destination: s.creador_ES, amount: 9500 } },
    a_obo: {
      application_fee_amount: 500,
      transfer_data: { destination: s.creador_ES },
      on_behalf_of: s.creador_ES,
    },
  })) {
    const pi = await stripe(
      'POST',
      '/v1/payment_intents',
      {
        amount: 10000,
        currency: 'eur',
        payment_method: 'pm_card_es',
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        ...extra,
      },
      { soft: true },
    );
    if (pi.__error) {
      log('dest ' + k, { error: pi.__error.message });
      continue;
    }
    let ch;
    for (let i = 0; i < 10; i++) {
      await sleep(1200);
      ch = await stripe('GET', '/v1/charges/' + pi.latest_charge, {
        expand: [
          'balance_transaction',
          'transfer.balance_transaction',
          'application_fee.balance_transaction',
        ],
      });
      if (ch.balance_transaction && ch.transfer) break;
    }
    log('dest ' + k, {
      pi: pi.id,
      bt_cobro: await B(ch.balance_transaction.id),
      transfer: {
        id: ch.transfer.id,
        amount: ch.transfer.amount,
        bt: ch.transfer.balance_transaction.id,
      },
      app_fee: ch.application_fee && {
        id: ch.application_fee.id,
        amount: ch.application_fee.amount,
        bt: ch.application_fee.balance_transaction?.id,
      },
      plataforma_neto:
        ch.balance_transaction.net - ch.transfer.amount + (ch.application_fee?.amount ?? 0),
    });
    s['dest_' + k] = { pi: pi.id, charge: ch.id, transfer: ch.transfer.id };
    saveState(s);
    if (k === 'a_app_fee') {
      // ¿Se puede repercutir después el coste real con una reversión parcial de la transferencia?
      const rev = await stripe(
        'POST',
        `/v1/transfers/${ch.transfer.id}/reversals`,
        { amount: ch.balance_transaction.fee, description: 'repercutir coste real de Stripe' },
        { soft: true },
      );
      log(
        'dest a: reversión parcial = fee real',
        rev.__error
          ? { error: rev.__error.message }
          : { id: rev.id, amount: rev.amount, bt: rev.balance_transaction },
      );
    }
  }
}
