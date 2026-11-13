import { describe, expect, it } from 'vitest';
import { PlatformStripeApiError, PlatformStripeConfigError } from '../src/errors.js';
import {
  FetchPlatformStripeClient,
  PLATFORM_STRIPE_API_VERSION,
  PLATFORM_STRIPE_V2_API_VERSION,
  encodeStripeForm,
  encodeStripeV2Query,
  stripeKeyLivemode,
  type FetchLike,
} from '../src/stripe/platform-stripe.client.js';

// ============================================================================
// Cliente de Stripe de plataforma sobre `fetch`. Aquí NO se habla con Stripe:
// se inyecta un `fetch` que graba la petición. Lo que estos tests fijan es la
// FORMA de lo que sale por el cable (formulario en v1, JSON en v2, cabeceras
// de versión, de cuenta y de idempotencia), que es justo lo que el sandbox
// (`tools/payments-sandbox/10-venta-unica.mjs`) comprueba contra Stripe real.
//
// La clave es una cadena de test con la forma de una clave, no una clave.
// ============================================================================

const CLAVE = 'sk_test_inventada0000';

interface Grabada {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  hasSignal: boolean;
}

function fetchQueResponde(
  status: number,
  cuerpo: unknown,
  cabeceras: Record<string, string> = {},
): { fetch: FetchLike; peticiones: Grabada[] } {
  const peticiones: Grabada[] = [];
  const fetch: FetchLike = async (url, init) => {
    peticiones.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      hasSignal: init.signal !== undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => cabeceras[name.toLowerCase()] ?? null },
      text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    };
  };
  return { fetch, peticiones };
}

describe('versiones fijadas', () => {
  it('v1 es la que devolvió el sandbox y v2 la de vista previa de Accounts v2', () => {
    expect(PLATFORM_STRIPE_API_VERSION).toBe('2026-10-28.endive');
    expect(PLATFORM_STRIPE_V2_API_VERSION).toBe('2026-10-28.preview');
  });
});

describe('encodeStripeForm — notación de corchetes de la API v1', () => {
  it('anida objetos y arrays como lo espera Stripe', () => {
    expect(
      encodeStripeForm({
        amount: 9325,
        currency: 'eur',
        destination: 'acct_1',
        source_transaction: 'ch_1',
        metadata: { sale_id: 's1', nested: { a: 1 } },
        expand: ['balance_transaction', 'destination_payment.balance_transaction'],
        line_items: [{ price: 'price_1', quantity: 1 }],
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      }),
    ).toEqual([
      ['amount', '9325'],
      ['currency', 'eur'],
      ['destination', 'acct_1'],
      ['source_transaction', 'ch_1'],
      ['metadata[sale_id]', 's1'],
      ['metadata[nested][a]', '1'],
      ['expand[0]', 'balance_transaction'],
      ['expand[1]', 'destination_payment.balance_transaction'],
      ['line_items[0][price]', 'price_1'],
      ['line_items[0][quantity]', '1'],
      ['automatic_payment_methods[enabled]', 'true'],
      ['automatic_payment_methods[allow_redirects]', 'never'],
    ]);
  });

  it('omite undefined y null, pero conserva false, 0 y la cadena vacía', () => {
    expect(
      encodeStripeForm({ a: undefined, b: null, c: false, d: 0, e: '', f: { g: undefined } }),
    ).toEqual([
      ['c', 'false'],
      ['d', '0'],
      ['e', ''],
    ]);
  });

  it('una fecha viaja como segundos Unix', () => {
    expect(encodeStripeForm({ frozen_time: new Date('2026-11-12T00:00:00Z') })).toEqual([
      ['frozen_time', '1794441600'],
    ]);
  });

  it('sin parámetros no produce nada', () => {
    expect(encodeStripeForm(undefined)).toEqual([]);
    expect(encodeStripeForm({})).toEqual([]);
  });
});

describe('encodeStripeV2Query', () => {
  it('las listas van como clave repetida, no con corchetes', () => {
    expect(encodeStripeV2Query({ include: ['requirements', 'identity'], limit: 1 })).toEqual([
      ['include', 'requirements'],
      ['include', 'identity'],
      ['limit', '1'],
    ]);
  });
});

describe('stripeKeyLivemode', () => {
  it.each([
    ['sk_test_abc123', false],
    ['rk_test_abc123', false],
    ['sk_live_abc123', true],
    ['rk_live_abc123', true],
  ])('%s → livemode %s', (clave, livemode) => {
    expect(stripeKeyLivemode(clave)).toBe(livemode);
  });

  it.each(['', 'pk_test_abc123', 'whsec_abc123', 'sk_test_', 'sk_prod_abc', ' sk_test_abc123'])(
    'rechaza «%s» sin repetirla en el error',
    (clave) => {
      let error: unknown;
      try {
        stripeKeyLivemode(clave);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(PlatformStripeConfigError);
      if (clave.trim().length > 0) {
        expect((error as Error).message).not.toContain(clave.trim());
      }
    },
  );
});

describe('FetchPlatformStripeClient — API v1', () => {
  it('POST: formulario, versión fijada, cuenta e idempotencia en cabeceras', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, { id: 'tr_1', amount: 9325 });
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    const transfer = await cliente.v1<{ id: string; amount: number }>(
      'POST',
      '/v1/transfers',
      {
        amount: 9325,
        currency: 'eur',
        destination: 'acct_creador',
        source_transaction: 'ch_1',
        metadata: { sale_id: 's1' },
      },
      { idempotencyKey: 'payouts:transfer:s1' },
    );

    expect(transfer).toEqual({ id: 'tr_1', amount: 9325 });
    expect(peticiones).toHaveLength(1);
    const p = peticiones[0]!;
    expect(p.url).toBe('https://api.stripe.com/v1/transfers');
    expect(p.method).toBe('POST');
    expect(p.headers).toEqual({
      Authorization: `Bearer ${CLAVE}`,
      'Stripe-Version': '2026-10-28.endive',
      'Idempotency-Key': 'payouts:transfer:s1',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(p.body).toBe(
      'amount=9325&currency=eur&destination=acct_creador&source_transaction=ch_1&metadata%5Bsale_id%5D=s1',
    );
    expect(p.hasSignal).toBe(true);
  });

  it('GET: los parámetros van en la consulta y no hay cuerpo ni Content-Type', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, { id: 'ch_1' });
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    await cliente.v1('GET', '/v1/charges/ch_1', { expand: ['balance_transaction'] });

    const p = peticiones[0]!;
    expect(p.url).toBe('https://api.stripe.com/v1/charges/ch_1?expand%5B0%5D=balance_transaction');
    expect(p.body).toBeUndefined();
    expect(p.headers['Content-Type']).toBeUndefined();
    expect(p.headers['Idempotency-Key']).toBeUndefined();
  });

  it('actuar sobre una cuenta conectada: cabecera Stripe-Account', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, { object: 'balance' });
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    await cliente.v1('GET', '/v1/balance', undefined, { account: 'acct_creador' });

    expect(peticiones[0]!.headers['Stripe-Account']).toBe('acct_creador');
    expect(peticiones[0]!.headers['Stripe-Context']).toBeUndefined();
    expect(peticiones[0]!.url).toBe('https://api.stripe.com/v1/balance');
  });

  it('la versión se puede sustituir por llamada (v1 con la de vista previa)', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, { id: 'acct_1' });
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    await cliente.v1(
      'POST',
      '/v1/accounts',
      { country: 'ES' },
      { apiVersion: '2026-10-28.preview' },
    );

    expect(peticiones[0]!.headers['Stripe-Version']).toBe('2026-10-28.preview');
  });

  it('rechaza una ruta que no es de v1 sin llegar a la red', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, {});
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    await expect(cliente.v1('GET', '/v2/core/accounts')).rejects.toBeInstanceOf(
      PlatformStripeConfigError,
    );
    expect(peticiones).toHaveLength(0);
  });
});

describe('FetchPlatformStripeClient — API v2', () => {
  it('POST: JSON, versión de vista previa y Stripe-Context', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, { id: 'acct_v2' });
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });
    const cuerpo = {
      dashboard: 'express',
      identity: { country: 'es', entity_type: 'individual' },
      defaults: {
        responsibilities: { fees_collector: 'application', losses_collector: 'stripe' },
      },
      include: ['configuration.merchant', 'requirements'],
    };

    await cliente.v2('POST', '/v2/core/accounts', cuerpo, {
      account: 'acct_ctx',
      idempotencyKey: 'payouts:account:t1',
    });

    const p = peticiones[0]!;
    expect(p.url).toBe('https://api.stripe.com/v2/core/accounts');
    expect(p.headers).toEqual({
      Authorization: `Bearer ${CLAVE}`,
      'Stripe-Version': '2026-10-28.preview',
      'Stripe-Context': 'acct_ctx',
      'Idempotency-Key': 'payouts:account:t1',
      'Content-Type': 'application/json',
    });
    // JSON tal cual, sin corchetes: los arrays y los objetos anidados van enteros.
    expect(JSON.parse(p.body!)).toEqual(cuerpo);
    expect(p.headers['Stripe-Account']).toBeUndefined();
  });

  it('GET: consulta con claves repetidas y sin cuerpo', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, { id: 'acct_v2' });
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    await cliente.v2('GET', '/v2/core/accounts/acct_v2', { include: ['requirements', 'identity'] });

    const p = peticiones[0]!;
    expect(p.url).toBe(
      'https://api.stripe.com/v2/core/accounts/acct_v2?include=requirements&include=identity',
    );
    expect(p.body).toBeUndefined();
    expect(p.headers['Content-Type']).toBeUndefined();
  });

  it('rechaza una ruta que no es de v2', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, {});
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    await expect(cliente.v2('POST', '/v1/accounts', {})).rejects.toBeInstanceOf(
      PlatformStripeConfigError,
    );
    expect(peticiones).toHaveLength(0);
  });
});

describe('FetchPlatformStripeClient — errores', () => {
  it('un 4xx de Stripe se convierte en PlatformStripeApiError con el mensaje literal', async () => {
    const literal =
      'Connected accounts in BR cannot be created by platforms in ES. Please contact us via https://support.stripe.com/contact if you need further assistance.';
    const { fetch } = fetchQueResponde(
      400,
      {
        error: { message: literal, type: 'invalid_request_error', code: 'account_country_invalid' },
      },
      { 'request-id': 'req_abc' },
    );
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    const error = await cliente
      .v2('POST', '/v2/core/accounts', { identity: { country: 'br' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PlatformStripeApiError);
    const e = error as PlatformStripeApiError;
    expect(e.code).toBe('PAYOUTS_STRIPE_API_ERROR');
    expect(e.detail).toBe(literal);
    expect(e.status).toBe(400);
    expect(e.type).toBe('invalid_request_error');
    expect(e.stripeCode).toBe('account_country_invalid');
    expect(e.requestId).toBe('req_abc');
    expect(e.operation).toBe('POST /v2/core/accounts');
    expect(e.retryable).toBe(false);
  });

  it.each([
    [409, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [402, false],
    [404, false],
  ])('HTTP %s → retryable %s', async (status, retryable) => {
    const { fetch } = fetchQueResponde(status, { error: { message: 'x' } });
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });
    const error = (await cliente.v1('GET', '/v1/balance').catch((err: unknown) => err)) as
      | PlatformStripeApiError
      | undefined;
    expect(error).toBeInstanceOf(PlatformStripeApiError);
    expect(error!.status).toBe(status);
    expect(error!.retryable).toBe(retryable);
  });

  it('sin respuesta (red caída): status 0, reintentable y sin la clave en el mensaje', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError(`fetch failed con Bearer ${CLAVE}`);
    };
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });

    const error = (await cliente
      .v1('POST', '/v1/transfers', { amount: 1 })
      .catch((err: unknown) => err)) as PlatformStripeApiError;

    expect(error).toBeInstanceOf(PlatformStripeApiError);
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(CLAVE);
    expect(error.detail ?? '').not.toContain(CLAVE);
  });

  it('la operación del error no lleva la cadena de consulta', async () => {
    const { fetch } = fetchQueResponde(404, { error: { message: 'No such charge' } });
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });
    const error = (await cliente
      .v2('GET', '/v2/core/accounts/acct_x?include=requirements')
      .catch((err: unknown) => err)) as PlatformStripeApiError;
    expect(error.operation).toBe('GET /v2/core/accounts/acct_x');
  });

  it('una respuesta que no es JSON no revienta con un SyntaxError', async () => {
    const { fetch } = fetchQueResponde(502, '<html>Bad Gateway</html>');
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE, fetch });
    const error = (await cliente.v1('GET', '/v1/balance').catch((err: unknown) => err)) as
      | PlatformStripeApiError
      | undefined;
    expect(error).toBeInstanceOf(PlatformStripeApiError);
    expect(error!.status).toBe(502);
    expect(error!.retryable).toBe(true);
  });
});

describe('FetchPlatformStripeClient — la clave', () => {
  it('livemode sale del prefijo de la clave', () => {
    expect(new FetchPlatformStripeClient({ secretKey: CLAVE }).livemode).toBe(false);
    expect(
      new FetchPlatformStripeClient({ secretKey: 'rk_live_claveInventada0000' }).livemode,
    ).toBe(true);
  });

  it('una clave que no es de Stripe no construye el cliente', () => {
    expect(() => new FetchPlatformStripeClient({ secretKey: 'no-es-una-clave' })).toThrow(
      PlatformStripeConfigError,
    );
  });

  it('la clave no aparece al serializar ni al inspeccionar el cliente', () => {
    const cliente = new FetchPlatformStripeClient({ secretKey: CLAVE });
    expect(JSON.stringify(cliente)).not.toContain(CLAVE);
    expect(Object.keys(cliente)).toEqual(['livemode']);
    expect(String(Object.values(cliente))).not.toContain(CLAVE);
  });

  it('respeta baseUrl (sin barra final duplicada)', async () => {
    const { fetch, peticiones } = fetchQueResponde(200, {});
    const cliente = new FetchPlatformStripeClient({
      secretKey: CLAVE,
      fetch,
      baseUrl: 'http://localhost:12111/',
    });
    await cliente.v1('GET', '/v1/balance');
    expect(peticiones[0]!.url).toBe('http://localhost:12111/v1/balance');
  });
});
