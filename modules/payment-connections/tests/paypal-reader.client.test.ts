import { describe, it, expect } from 'vitest';
import { PayPalReadSdkAdapter } from '../src/paypal-reader.client.js';
import { StripeReadKeyInvalidError } from '../src/errors.js';

/**
 * Tests del lector PayPal con `fetch` mockeado (sin red). Foco: el flujo de
 * Transaction Search y los mensajes de error precisos cuando el permiso de
 * reporting no está activo/propagado (causa típica del 403 con la app recién
 * creada). El reporting de PayPal NO permite filtrar por email, así que el
 * adaptador escanea transacciones y filtra por el email del pagador.
 */

const REPORTING_SCOPE = 'https://uri.paypal.com/services/reporting/search/read';

interface FakeResp {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function resp(status: number, body: unknown): FakeResp {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Transacción recurrente (suscripción) de PayPal para buyer@x.com. */
const RECURRING_TXN = {
  transaction_info: {
    transaction_id: 'T1',
    paypal_reference_id: 'I-SUB1',
    paypal_reference_id_type: 'SUB',
    transaction_initiation_date: '2026-06-01T10:00:00+0000',
    transaction_amount: { currency_code: 'EUR', value: '29.99' },
  },
  payer_info: {
    account_id: 'ACC1',
    email_address: 'buyer@x.com',
    payer_name: { given_name: 'Buy', surname: 'Er' },
  },
};

/**
 * Construye un `fetch` falso: el endpoint de token devuelve los `scope` indicados;
 * el de reporting delega en `onReporting` (por defecto, una página con la txn).
 */
function fakeFetch(opts: { scope: string; onReporting?: (url: string) => FakeResp }): typeof fetch {
  const onReporting =
    opts.onReporting ?? (() => resp(200, { transaction_details: [RECURRING_TXN], total_pages: 1 }));
  const fn = async (input: string | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes('/v1/oauth2/token')) {
      return resp(200, {
        access_token: 'tok_123',
        app_id: 'APP-1',
        scope: opts.scope,
      }) as unknown as Response;
    }
    if (url.includes('/v1/reporting/transactions')) {
      return onReporting(url) as unknown as Response;
    }
    throw new Error(`URL no esperada en el mock: ${url}`);
  };
  return fn as unknown as typeof fetch;
}

const CREDS = { clientId: 'cid', clientSecret: 'sec', environment: 'live' as const };

describe('PayPalReadSdkAdapter · Transaction Search', () => {
  it('sin el scope de reporting: error preciso y accionable (Transaction Search no activo)', async () => {
    const adapter = new PayPalReadSdkAdapter(CREDS, fakeFetch({ scope: 'openid' }), 1);
    await expect(adapter.findSubscriptionsByEmail('buyer@x.com')).rejects.toBeInstanceOf(
      StripeReadKeyInvalidError,
    );
    await expect(adapter.findSubscriptionsByEmail('buyer@x.com')).rejects.toThrow(
      /Transaction Search/i,
    );
  });

  it('con el scope: encuentra la suscripción del email (filtra por pagador)', async () => {
    const adapter = new PayPalReadSdkAdapter(
      CREDS,
      fakeFetch({ scope: `openid ${REPORTING_SCOPE}` }),
      1,
    );
    const subs = await adapter.findSubscriptionsByEmail('BUYER@x.com'); // case-insensitive
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      subscriptionId: 'I-SUB1',
      status: 'active',
      email: 'buyer@x.com',
      unitAmount: 2999,
      currency: 'EUR',
    });
  });

  it('email sin coincidencia: lista vacía (no error)', async () => {
    const adapter = new PayPalReadSdkAdapter(
      CREDS,
      fakeFetch({ scope: `openid ${REPORTING_SCOPE}` }),
      1,
    );
    expect(await adapter.findSubscriptionsByEmail('otro@x.com')).toEqual([]);
  });

  it('scope presente pero reporting 403: mensaje de "reintenta más tarde" (no genérico)', async () => {
    const adapter = new PayPalReadSdkAdapter(
      CREDS,
      fakeFetch({ scope: `openid ${REPORTING_SCOPE}`, onReporting: () => resp(403, {}) }),
      1,
    );
    await expect(adapter.findSubscriptionsByEmail('buyer@x.com')).rejects.toThrow(
      /Reintenta más tarde/i,
    );
  });
});
