import { describe, expect, it } from 'vitest';
import { PlatformStripeApiError } from '../src/errors.js';
import { computeSplit } from '../src/money.js';
import { IDEMPOTENCY_KEYS } from '../src/ledger.service.js';
import { InMemoryPlatformStripeClient } from '../src/stripe/platform-stripe.fake.js';
import type { PlatformStripeClient } from '../src/stripe/platform-stripe.client.js';

// ============================================================================
// El doble en memoria de Stripe. Lo que se prueba aquí es que el doble se
// comporta como el dominio va a necesitar en E4 (cargo sin comisión todavía →
// llega la comisión → transferencia exacta, reintento idempotente, fallo
// inyectado), no la lógica de liquidación, que aún no existe.
// ============================================================================

/** Un cargo como lo devuelve Stripe justo al confirmar: sin balance_transaction. */
function cargoRecienCobrado() {
  return {
    id: 'ch_1',
    object: 'charge',
    amount: 10000,
    currency: 'eur',
    payment_intent: 'pi_1',
    balance_transaction: null,
  };
}

const BT = {
  id: 'txn_1',
  object: 'balance_transaction',
  amount: 10000,
  fee: 175,
  net: 9825,
  currency: 'eur',
};

function conTransferencias(fake: InMemoryPlatformStripeClient): InMemoryPlatformStripeClient {
  return fake.on('POST', '/v1/transfers', ({ params }, f) => {
    const transfer = {
      id: f.nextId('tr'),
      object: 'transfer',
      amount: params['amount'],
      currency: params['currency'],
      destination: params['destination'],
      source_transaction: params['source_transaction'],
    };
    f.seed(transfer);
    return transfer;
  });
}

describe('InMemoryPlatformStripeClient', () => {
  it('cumple el contrato PlatformStripeClient', () => {
    const cliente: PlatformStripeClient = new InMemoryPlatformStripeClient();
    expect(cliente.livemode).toBe(false);
    expect(new InMemoryPlatformStripeClient({ livemode: true }).livemode).toBe(true);
  });

  it('GET por id devuelve lo sembrado y resuelve expand contra el almacén', async () => {
    const fake = new InMemoryPlatformStripeClient().seed(
      { id: 'pi_1', object: 'payment_intent', latest_charge: 'ch_1' },
      { ...cargoRecienCobrado(), balance_transaction: 'txn_1' },
      BT,
    );

    const sinExpandir = await fake.v1('GET', '/v1/payment_intents/pi_1');
    expect(sinExpandir['latest_charge']).toBe('ch_1');

    const expandido = await fake.v1<{
      latest_charge: { id: string; balance_transaction: { fee: number } };
    }>('GET', '/v1/payment_intents/pi_1', { expand: ['latest_charge.balance_transaction'] });
    expect(expandido.latest_charge.id).toBe('ch_1');
    expect(expandido.latest_charge.balance_transaction.fee).toBe(175);

    // Expandir no altera lo guardado.
    expect(fake.get('pi_1')!['latest_charge']).toBe('ch_1');
  });

  it('un cargo recién cobrado no tiene comisión; al llegar, el reparto es exacto', async () => {
    const fake = conTransferencias(new InMemoryPlatformStripeClient()).seed(cargoRecienCobrado());

    const antes = await fake.v1<{ balance_transaction: unknown }>('GET', '/v1/charges/ch_1', {
      expand: ['balance_transaction'],
    });
    expect(antes.balance_transaction).toBeNull();

    // Llega `charge.updated`: Stripe ya asignó la balance_transaction.
    fake.seed(BT).patch('ch_1', { balance_transaction: 'txn_1' });
    const despues = await fake.v1<{ balance_transaction: { amount: number; fee: number } }>(
      'GET',
      '/v1/charges/ch_1',
      { expand: ['balance_transaction'] },
    );
    const split = computeSplit({
      gross: despues.balance_transaction.amount,
      stripeFee: despues.balance_transaction.fee,
      feeBps: 500,
    });
    const transfer = await fake.v1<{ id: string; amount: number }>(
      'POST',
      '/v1/transfers',
      {
        amount: split.creatorNet,
        currency: 'eur',
        destination: 'acct_creador',
        source_transaction: 'ch_1',
      },
      { idempotencyKey: IDEMPOTENCY_KEYS.transfer('venta-1') },
    );

    expect(transfer.amount).toBe(9325);
    expect(fake.get(transfer.id)).toMatchObject({ amount: 9325, destination: 'acct_creador' });
  });

  it('POST repetido con la misma clave: una sola ejecución y la misma respuesta', async () => {
    const fake = conTransferencias(new InMemoryPlatformStripeClient());
    const params = {
      amount: 9325,
      currency: 'eur',
      destination: 'acct_1',
      source_transaction: 'ch_1',
    };
    const opciones = { idempotencyKey: IDEMPOTENCY_KEYS.transfer('venta-1') };

    const respuestas = [];
    for (let i = 0; i < 5; i += 1) {
      respuestas.push(await fake.v1<{ id: string }>('POST', '/v1/transfers', params, opciones));
    }

    expect(new Set(respuestas.map((r) => r.id)).size).toBe(1);
    // Las cinco llamadas quedan grabadas, pero solo se creó UNA transferencia.
    expect(fake.callsTo('POST', '/v1/transfers')).toHaveLength(5);
    expect(fake.get('tr_fake_1')).toBeDefined();
    expect(fake.get('tr_fake_2')).toBeUndefined();
  });

  it('control: sin clave de idempotencia cada POST crea otra transferencia', async () => {
    const fake = conTransferencias(new InMemoryPlatformStripeClient());
    const params = {
      amount: 9325,
      currency: 'eur',
      destination: 'acct_1',
      source_transaction: 'ch_1',
    };

    const a = await fake.v1<{ id: string }>('POST', '/v1/transfers', params);
    const b = await fake.v1<{ id: string }>('POST', '/v1/transfers', params);

    expect(a.id).not.toBe(b.id);
  });

  it('la misma clave con otros parámetros falla como en Stripe', async () => {
    const fake = conTransferencias(new InMemoryPlatformStripeClient());
    const opciones = { idempotencyKey: IDEMPOTENCY_KEYS.transfer('venta-1') };
    await fake.v1('POST', '/v1/transfers', { amount: 9325, currency: 'eur' }, opciones);

    const error = (await fake
      .v1('POST', '/v1/transfers', { amount: 9999, currency: 'eur' }, opciones)
      .catch((err: unknown) => err)) as PlatformStripeApiError;

    expect(error).toBeInstanceOf(PlatformStripeApiError);
    expect(error.type).toBe('idempotency_error');
    expect(error.status).toBe(400);
  });

  it('failNext: falla una vez (saldo insuficiente) y el reintento con la misma clave funciona', async () => {
    const fake = conTransferencias(new InMemoryPlatformStripeClient()).failNext('/v1/transfers', {
      message: 'Insufficient funds in Stripe account.',
      status: 400,
      stripeCode: 'balance_insufficient',
    });
    const params = { amount: 9325, currency: 'eur', destination: 'acct_1' };
    const opciones = { idempotencyKey: IDEMPOTENCY_KEYS.transfer('venta-1') };

    const error = (await fake
      .v1('POST', '/v1/transfers', params, opciones)
      .catch((err: unknown) => err)) as PlatformStripeApiError;
    expect(error).toBeInstanceOf(PlatformStripeApiError);
    expect(error.stripeCode).toBe('balance_insufficient');
    expect(error.detail).toBe('Insufficient funds in Stripe account.');

    // Un fallo no deja respuesta guardada bajo la clave: el reintento ejecuta.
    const ok = await fake.v1<{ id: string; amount: number }>(
      'POST',
      '/v1/transfers',
      params,
      opciones,
    );
    expect(ok.amount).toBe(9325);
    expect(fake.callsTo('POST', '/v1/transfers')).toHaveLength(2);
  });

  it('failNext solo afecta a la ruta y al método que casan', async () => {
    const fake = new InMemoryPlatformStripeClient()
      .seed({ id: 'ch_1', object: 'charge' })
      .failNext(/^\/v1\/refunds$/, { message: 'boom', status: 500, method: 'POST' });

    await expect(fake.v1('GET', '/v1/charges/ch_1')).resolves.toMatchObject({ id: 'ch_1' });
    const error = (await fake.v1('POST', '/v1/refunds', {}).catch((err: unknown) => err)) as
      | PlatformStripeApiError
      | undefined;
    expect(error?.status).toBe(500);
    expect(error?.retryable).toBe(true);
  });

  it('rutas con parámetros: reversión de una transferencia concreta', async () => {
    const fake = new InMemoryPlatformStripeClient()
      .seed({ id: 'tr_1', object: 'transfer', amount: 9325, amount_reversed: 0 })
      .on('POST', '/v1/transfers/:transfer/reversals', ({ pathParams, params }, f) => {
        const transfer = f.get(pathParams['transfer']!)!;
        const amount = Number(params['amount']);
        f.patch(transfer['id'] as string, {
          amount_reversed: Number(transfer['amount_reversed']) + amount,
        });
        return {
          id: f.nextId('trr'),
          object: 'transfer_reversal',
          amount,
          transfer: transfer['id'],
        };
      });

    const reversion = await fake.v1<{ amount: number; transfer: string }>(
      'POST',
      '/v1/transfers/tr_1/reversals',
      { amount: 3730 },
      { idempotencyKey: IDEMPOTENCY_KEYS.reversal('reembolso-1') },
    );

    expect(reversion).toMatchObject({ amount: 3730, transfer: 'tr_1' });
    expect(fake.get('tr_1')!['amount_reversed']).toBe(3730);
  });

  it('una ruta sin definir o un id que no existe da 404, no undefined', async () => {
    const fake = new InMemoryPlatformStripeClient();

    const sinRuta = (await fake.v1('POST', '/v1/payouts', {}).catch((err: unknown) => err)) as
      | PlatformStripeApiError
      | undefined;
    expect(sinRuta).toBeInstanceOf(PlatformStripeApiError);
    expect(sinRuta!.status).toBe(404);
    expect(sinRuta!.stripeCode).toBe('resource_missing');

    await expect(fake.v1('GET', '/v1/charges/ch_no_existe')).rejects.toBeInstanceOf(
      PlatformStripeApiError,
    );
  });

  it('graba cada llamada con su API, parámetros y opciones', async () => {
    const fake = new InMemoryPlatformStripeClient().on('POST', '/v2/core/accounts', () => ({
      id: 'acct_v2',
    }));

    await fake.v2('POST', '/v2/core/accounts', { dashboard: 'express' }, { account: 'acct_ctx' });

    expect(fake.calls).toEqual([
      {
        api: 'v2',
        method: 'POST',
        path: '/v2/core/accounts',
        params: { dashboard: 'express' },
        options: { account: 'acct_ctx' },
      },
    ]);
  });

  it('no deja mezclar las dos API', async () => {
    const fake = new InMemoryPlatformStripeClient();
    await expect(fake.v1('GET', '/v2/core/accounts')).rejects.toThrow(/no es de la API v1/);
    await expect(fake.v2('GET', '/v1/accounts')).rejects.toThrow(/no es de la API v2/);
  });

  it('lo que devuelve es una copia: mutarlo no toca el almacén', async () => {
    const fake = new InMemoryPlatformStripeClient().seed({ id: 'ch_1', metadata: { a: 1 } });
    const cargo = await fake.v1<{ metadata: { a: number } }>('GET', '/v1/charges/ch_1');
    cargo.metadata.a = 99;
    expect((fake.get('ch_1')!['metadata'] as { a: number }).a).toBe(1);
  });

  it('seed exige un id', () => {
    expect(() => new InMemoryPlatformStripeClient().seed({ object: 'charge' })).toThrow(/id/);
  });
});
