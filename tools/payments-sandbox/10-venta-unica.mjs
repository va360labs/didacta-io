/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Venta única en modo plataforma, contra el sandbox de Stripe DE VERDAD:
 * cobro en la cuenta de la plataforma → esperar a que el cargo tenga su
 * comisión real → transferir al creador `bruto − comisión de Stripe − comisión
 * del operador`.
 *
 * No usa una reimplementación: cobra y transfiere con el cliente del módulo
 * (`FetchPlatformStripeClient`) y reparte con su `computeSplit`. Lo que aquí
 * sale bien es lo que hará producción: la codificación del formulario, la
 * versión de API fijada, la clave de idempotencia y el redondeo.
 *
 * Y compara el resultado con `modules/payouts/tests/fixtures/sandbox-2026-11-12.json`,
 * que es de donde salen los importes de los tests unitarios. Si Stripe cambia
 * sus comisiones de prueba, o el reparto deja de cuadrar, sale con código 1.
 *
 * Uso (antes: `pnpm --filter @didacta/mod-payouts build`):
 *   node tools/payments-sandbox/10-venta-unica.mjs            # los 3 casos base
 *   node tools/payments-sandbox/10-venta-unica.mjs --todos    # los 11 casos de tarjeta
 *   node tools/payments-sandbox/10-venta-unica.mjs t_gbp100_obo_GB
 *
 * Los casos con cambio de divisa (el alumno paga en una divisa y el cargo se
 * liquida en otra) dependen del tipo de cambio del día: en esos se comprueba
 * el reparto y la transferencia, no el bruto.
 *
 * Cada ejecución crea cobros y transferencias de PRUEBA en el sandbox.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripe, log, loadState, saveState, sleep, bt } from './lib2.mjs';
import { testKey } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

function loadPayoutsModule() {
  const dist = path.join(REPO, 'modules/payouts/dist/index.js');
  if (!fs.existsSync(dist)) {
    console.error(
      'PARADA: falta modules/payouts/dist. Compílalo antes: pnpm --filter @didacta/mod-payouts build',
    );
    process.exit(2);
  }
  return createRequire(import.meta.url)(dist);
}

const { FetchPlatformStripeClient, IDEMPOTENCY_KEYS, PLATFORM_STRIPE_API_VERSION, computeSplit } =
  loadPayoutsModule();

const client = new FetchPlatformStripeClient({ secretKey: testKey() });
const s = loadState();
const C = s.creador_ES;
const B = (id, o) => bt(stripe, id, o);
const bal = async (acct) => {
  const b = await client.v1('GET', '/v1/balance', {}, acct ? { account: acct } : {});
  return {
    available: b.available.map((x) => `${x.amount} ${x.currency}`),
    pending: b.pending.map((x) => `${x.amount} ${x.currency}`),
  };
};

/** Segundos máximos esperando la `balance_transaction` del cargo (documentado: hasta 1 h). */
const MAX_ESPERA_BT_SEG = 120;

/**
 * Una venta completa. Devuelve el detalle (o `null` si el cobro falló) y lo
 * apunta en `state.json` como `t_<label>`, que es de donde lo leen los scripts
 * de reembolsos, disputas y saldo negativo.
 */
export async function venta({
  label,
  amount = 10000,
  currency = 'eur',
  pm = 'pm_card_visa',
  dest = C,
  feeBps = 500,
  extra = {},
  transferCurrency,
}) {
  const tg = 'venta_' + label + '_' + Date.now();
  let pi;
  try {
    pi = await client.v1('POST', '/v1/payment_intents', {
      amount,
      currency,
      payment_method: pm,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      transfer_group: tg,
      description: 'prueba ' + label,
      metadata: { creador: dest, prueba: label },
      expand: ['latest_charge.balance_transaction'],
      ...extra,
    });
  } catch (err) {
    log(label + ' COBRO ERROR', { msg: err.detail ?? err.message, code: err.stripeCode });
    return null;
  }

  // Al confirmar, el cargo llega SIN balance_transaction: hay que esperarla.
  let ch = pi.latest_charge;
  let b = ch.balance_transaction;
  let esperas = 0;
  while (!b) {
    if (esperas >= MAX_ESPERA_BT_SEG) {
      log(label + ' SIN balance_transaction', { charge: ch.id, esperas_seg: esperas });
      return null;
    }
    await sleep(1000);
    esperas++;
    ch = await client.v1('GET', '/v1/charges/' + ch.id, { expand: ['balance_transaction'] });
    b = ch.balance_transaction;
  }

  // Todo en la divisa de liquidación de la plataforma (b.currency).
  const split = computeSplit({ gross: b.amount, stripeFee: b.fee, feeBps });
  const out = {
    esperas_bt_seg: esperas,
    pi: pi.id,
    charge: ch.id,
    cobrado: `${ch.amount} ${ch.currency}`,
    descriptor: ch.calculated_statement_descriptor,
    on_behalf_of: ch.on_behalf_of,
    tarjeta: `${ch.payment_method_details?.card?.brand} ${ch.payment_method_details?.card?.country}`,
    bt_cobro: await B(b.id),
    divisa: b.currency,
    bruto: split.gross,
    fee: split.stripeFee,
    comision: split.platformFee,
    paraCreador: split.creatorNet,
  };

  let tr;
  try {
    tr = await client.v1(
      'POST',
      '/v1/transfers',
      {
        amount: split.creatorNet,
        currency: transferCurrency ?? b.currency,
        destination: dest,
        source_transaction: ch.id,
        transfer_group: tg,
        description: `venta ${label}: ${split.gross} - fee ${split.stripeFee} - comision ${split.platformFee}`,
        expand: ['balance_transaction', 'destination_payment.balance_transaction'],
      },
      { idempotencyKey: IDEMPOTENCY_KEYS.transfer(tg) },
    );
  } catch (err) {
    out.transfer_error = err.detail ?? err.message;
    log(label, out);
    return out;
  }

  const btCreador = tr.destination_payment?.balance_transaction;
  out.transfer = {
    id: tr.id,
    amount: `${tr.amount} ${tr.currency}`,
    importe: tr.amount,
    bt_plataforma: await B(tr.balance_transaction.id),
    destination_payment: tr.destination_payment?.id,
    bt_creador: btCreador
      ? {
          id: btCreador.id,
          type: btCreador.type,
          amount: btCreador.amount,
          fee: btCreador.fee,
          net: btCreador.net,
          currency: btCreador.currency,
          exchange_rate: btCreador.exchange_rate,
          available_on: new Date(btCreador.available_on * 1000).toISOString().slice(0, 10),
          status: btCreador.status,
        }
      : null,
  };
  out.neto_plataforma = split.gross - split.stripeFee - tr.amount;
  log(label, out);

  s['t_' + label] = {
    pi: pi.id,
    charge: ch.id,
    transfer: tr.id,
    bruto: split.gross,
    fee: split.stripeFee,
    comision: split.platformFee,
    paraCreador: split.creatorNet,
    bt_cobro: b.id,
    bt_transfer: tr.balance_transaction.id,
    dest,
  };
  saveState(s);
  return out;
}

/** Cómo se cobra cada caso del fixture. `obo`/`dest`: clave de la cuenta en el estado. */
const CASOS = {
  t_eur100_obo_ES: { pm: 'pm_card_es', dest: 'creador_ES', obo: true },
  t_eur100_obo_ES_tarjetaUS: { pm: 'pm_card_visa', dest: 'creador_ES', obo: true },
  t_unica30_tarjeta_ES: { pm: 'pm_card_es', dest: 'creador_ES', obo: false },
  t_unica100_tarjeta_GB: { pm: 'pm_card_gb', dest: 'creador_ES', obo: false },
  t_usd100_obo_US: { pm: 'pm_card_visa', dest: 'creador_US', obo: true },
  t_gbp100_obo_GB: { pm: 'pm_card_gb', dest: 'creador_GB', obo: true },
  t_eur100_obo_US: { pm: 'pm_card_es', dest: 'creador_US', obo: true },
  t_usd100_creador_ES: { pm: 'pm_card_visa', dest: 'creador_ES', obo: false },
  t_gbp100_creador_ES: { pm: 'pm_card_gb', dest: 'creador_ES', obo: false },
  t_mxn2000_creador_ES: { pm: 'pm_card_mx', dest: 'creador_ES', obo: false },
  t_brl500_creador_ES: { pm: 'pm_card_br', dest: 'creador_ES', obo: false },
};

/** 100 € con tarjeta ES, 30 € y 100 € con tarjeta US: los tres importes de referencia. */
const CASOS_BASE = ['t_eur100_obo_ES', 't_unica30_tarjeta_ES', 't_eur100_obo_ES_tarjetaUS'];

/** ¿La versión por defecto de la cuenta sigue siendo la que el módulo tiene fijada? */
async function comprobarVersion() {
  const res = await fetch('https://api.stripe.com/v1/balance', {
    headers: { Authorization: `Bearer ${testKey()}` },
  });
  const deLaCuenta = res.headers.get('stripe-version');
  const fijada = await fetch('https://api.stripe.com/v1/balance', {
    headers: {
      Authorization: `Bearer ${testKey()}`,
      'Stripe-Version': PLATFORM_STRIPE_API_VERSION,
    },
  });
  const ok = fijada.ok && fijada.headers.get('stripe-version') === PLATFORM_STRIPE_API_VERSION;
  log('versión de API', {
    fijada_en_el_modulo: PLATFORM_STRIPE_API_VERSION,
    por_defecto_de_la_cuenta: deLaCuenta,
    aceptada_por_stripe: ok,
  });
  return ok;
}

async function reproducirTabla(nombres) {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(REPO, 'modules/payouts/tests/fixtures/sandbox-2026-11-12.json'),
      'utf8',
    ),
  );
  const filas = [];
  let fallos = 0;

  for (const nombre of nombres) {
    const esperado = fixture.sales.find((v) => v.case === nombre);
    const caso = CASOS[nombre];
    if (!esperado || !caso) {
      console.error(`Caso desconocido: ${nombre}. Disponibles: ${Object.keys(CASOS).join(', ')}`);
      process.exit(2);
    }
    const cuenta = s[caso.dest];
    if (!cuenta) {
      console.error(`PARADA: el estado no tiene la cuenta ${caso.dest} (ver 05-crear-prefill.mjs)`);
      process.exit(2);
    }
    const out = await venta({
      label: nombre.replace(/^t_/, ''),
      amount: esperado.presentmentAmount,
      currency: esperado.presentmentCurrency,
      pm: caso.pm,
      dest: cuenta,
      feeBps: esperado.feeBps,
      extra: caso.obo ? { on_behalf_of: cuenta } : {},
    });

    // Con cambio de divisa el bruto depende del tipo de cambio del día.
    const conCambio = esperado.presentmentCurrency !== esperado.currency;
    const problemas = [];
    if (!out) problemas.push('el cobro falló');
    else if (out.transfer_error) problemas.push('transferencia: ' + out.transfer_error);
    else {
      if (out.divisa !== esperado.currency)
        problemas.push(`divisa ${out.divisa} ≠ ${esperado.currency}`);
      if (out.bruto - out.fee - out.comision !== out.paraCreador)
        problemas.push('no cuadra el invariante');
      if (out.transfer.importe !== out.paraCreador)
        problemas.push(`Stripe transfirió ${out.transfer.importe}, no ${out.paraCreador}`);
      if (out.neto_plataforma !== out.comision)
        problemas.push(`la plataforma se queda ${out.neto_plataforma}, no ${out.comision}`);
      if (out.transfer.bt_plataforma.amount !== -out.paraCreador)
        problemas.push('el movimiento de la plataforma no es −lo transferido');
      if (!conCambio) {
        for (const [campo, valor] of [
          ['gross', out.bruto],
          ['stripeFee', out.fee],
          ['platformFee', out.comision],
          ['creatorNet', out.paraCreador],
        ]) {
          if (valor !== esperado[campo])
            problemas.push(`${campo} ${valor} ≠ fixture ${esperado[campo]}`);
        }
      }
    }
    if (problemas.length) fallos++;
    filas.push({
      caso: nombre,
      bruto: out?.bruto,
      comision_stripe: out?.fee,
      comision_operador: out?.comision,
      al_creador: out?.paraCreador,
      divisa: out?.divisa,
      fixture: `${esperado.gross}/${esperado.stripeFee}/${esperado.platformFee}/${esperado.creatorNet} ${esperado.currency}`,
      charge: out?.charge,
      transfer: out?.transfer?.id,
      resultado: problemas.length
        ? 'FALLO: ' + problemas.join('; ')
        : conCambio
          ? 'OK (cambio de divisa: bruto del día)'
          : 'OK (idéntico al fixture)',
    });
  }

  console.log('\nRESULTADO');
  console.table(filas);
  return fallos;
}

const esPrincipal =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (esPrincipal) {
  const args = process.argv.slice(2);
  const nombres = args.includes('--todos')
    ? Object.keys(CASOS)
    : args.filter((a) => !a.startsWith('--')).length
      ? args.filter((a) => !a.startsWith('--'))
      : CASOS_BASE;

  const versionOk = await comprobarVersion();
  log('saldos antes', { plataforma: await bal(), creador_ES: await bal(C) });
  const fallos = await reproducirTabla(nombres);
  await sleep(1500);
  log('saldos después', { plataforma: await bal(), creador_ES: await bal(C) });

  if (!versionOk) console.error('FALLO: Stripe no acepta la versión de API fijada en el módulo');
  console.log(
    fallos === 0 && versionOk
      ? `\nOK: ${nombres.length} caso(s) reproducidos contra el sandbox.`
      : `\nFALLO: ${fallos} caso(s) no cuadran.`,
  );
  process.exit(fallos === 0 && versionOk ? 0 : 1);
}
