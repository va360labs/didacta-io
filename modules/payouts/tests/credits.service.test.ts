/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Crédito de la plataforma a la cuenta del aula (afiliados, ADR-008). Mueve
 * dinero del operador sin venta detrás: lo que se prueba aquí es sobre todo
 * que una clave de idempotencia produce COMO MUCHO una transferencia, y que
 * cada comprobación discrimina (con un caso de control al lado).
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryPlatformStripeClient,
  PayoutsCreditsService,
  PayoutsError,
  PlatformStripeApiError,
  creditLedgerKey,
  creditTransferGroup,
} from '../src/index.js';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';
import { installTransfers, type FakeTransfers } from './helpers/stripe-world.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'acct_1CreadorA';
const ACCT_B = 'acct_1CreadorB';
const KEY = 'aff:af0001:eur:2026-W47';

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;
let transfers: FakeTransfers;
let credits: PayoutsCreditsService;
const accountId: Record<string, string> = {};

function addAccount(tenantId: string, stripeAccountId: string | null, status = 'READY') {
  accountId[tenantId] = randomUUID();
  db.insert('modPayoutsAccount', {
    id: accountId[tenantId],
    tenantId,
    stripeAccountId,
    status,
    country: 'ES',
    entityType: 'individual',
  });
}

beforeEach(() => {
  db = new FakePayoutsDb();
  fake = new InMemoryPlatformStripeClient();
  transfers = installTransfers(fake);
  credits = new PayoutsCreditsService(db.port(), fake, { maxMinor: 500_000 });
  addAccount(A, ACCT_A);
  addAccount(B, ACCT_B);
});

const base = {
  tenantId: A,
  amount: 1250,
  currency: 'eur',
  idempotencyKey: KEY,
  reason: 'Afiliación 2026-W47',
};
const postCalls = () => fake.callsTo('POST', '/v1/transfers');
const ledger = (tenantId = A) => db.rows('modPayoutsLedgerEntry', { tenantId });

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof PayoutsError ? err.code : `OTRO:${String(err)}`;
  }
}

describe('crédito: camino feliz', () => {
  it('transfiere a la cuenta del aula con la clave como Idempotency-Key y anota ADJUSTMENT(+) y TRANSFER(−)', async () => {
    const result = await credits.credit(base);

    expect(result).toEqual({
      transferId: transfers.all[0]!['id'],
      amount: 1250,
      currency: 'eur',
      created: true,
    });
    // Una sola transferencia, sin `source_transaction` (sale del saldo del operador).
    expect(transfers.all).toHaveLength(1);
    const call = postCalls()[0]!;
    expect(call.params).toMatchObject({
      amount: 1250,
      currency: 'eur',
      destination: ACCT_A,
      transfer_group: creditTransferGroup(A, KEY),
      description: 'Afiliación 2026-W47',
    });
    expect(call.params).not.toHaveProperty('source_transaction');
    expect(call.options.idempotencyKey).toBe(creditLedgerKey(A, KEY));
    expect(transfers.all[0]!['metadata']).toMatchObject({
      didacta_credit_key: creditLedgerKey(A, KEY),
      didacta_tenant_id: A,
    });

    const entries = ledger();
    expect(entries).toHaveLength(2);
    const adjustment = entries.find((e) => e['type'] === 'ADJUSTMENT')!;
    const transfer = entries.find((e) => e['type'] === 'TRANSFER')!;
    expect(adjustment).toMatchObject({
      amount: 1250,
      currency: 'eur',
      accountId: accountId[A],
      saleId: null,
      metadata: expect.objectContaining({ cause: 'affiliate_credit', idempotencyKey: KEY }),
    });
    expect(transfer).toMatchObject({
      amount: -1250,
      currency: 'eur',
      accountId: accountId[A],
      saleId: null,
      stripeObjectId: result.transferId,
      idempotencyKey: creditLedgerKey(A, KEY),
    });
    // Suma 0: el invariante del conciliador (Σ libro = pendiente de transferir) no se toca.
    expect(entries.reduce((sum, e) => sum + (e['amount'] as number), 0)).toBe(0);
    // No se confunde con la transferencia de una venta ni con un reintegro de disputa.
    expect(String(transfer['idempotencyKey'])).not.toMatch(/^payouts:(transfer|reinstate):/);
    // La transferencia queda atribuida al aula para sus webhooks.
    expect(db.rows('modPayoutsObjectRef', { stripeObjectId: result.transferId })).toHaveLength(1);
  });
});

describe('crédito: idempotencia', () => {
  it('la misma clave dos veces → UNA transferencia, dos asientos, el mismo transferId', async () => {
    const first = await credits.credit(base);
    const second = await credits.credit(base);

    expect(second).toEqual({ ...first, created: false });
    expect(transfers.all).toHaveLength(1);
    expect(postCalls()).toHaveLength(1);
    expect(ledger()).toHaveLength(2);
  });

  it('el reintento no llama a Stripe ni mira la cuenta: sigue valiendo aunque se haya restringido después', async () => {
    const first = await credits.credit(base);
    const callsBefore = fake.calls.length;
    db.update('modPayoutsAccount', { tenantId: A }, { status: 'RESTRICTED' });

    await expect(credits.credit(base)).resolves.toEqual({ ...first, created: false });
    expect(fake.calls).toHaveLength(callsBefore);

    // CONTROL: una clave NUEVA con la cuenta restringida sí se rechaza.
    await expect(
      codeOf(() => credits.credit({ ...base, idempotencyKey: `${KEY}-otra` })),
    ).resolves.toBe('PAYOUTS_CREDIT_NO_ACCOUNT');
  });

  it('la misma clave con OTRO importe o divisa → conflicto, sin devolver el crédito viejo ni crear otro', async () => {
    await credits.credit(base);
    await expect(codeOf(() => credits.credit({ ...base, amount: 1251 }))).resolves.toBe(
      'PAYOUTS_CREDIT_IDEMPOTENCY_CONFLICT',
    );
    await expect(codeOf(() => credits.credit({ ...base, currency: 'usd' }))).resolves.toBe(
      'PAYOUTS_CREDIT_IDEMPOTENCY_CONFLICT',
    );
    expect(transfers.all).toHaveLength(1);
    expect(ledger()).toHaveLength(2);
  });

  it('claves distintas son créditos distintos (control: la clave es lo que discrimina)', async () => {
    const one = await credits.credit(base);
    const two = await credits.credit({ ...base, idempotencyKey: 'aff:af0001:eur:2026-W48' });
    expect(two.transferId).not.toBe(one.transferId);
    expect(transfers.all).toHaveLength(2);
    expect(ledger()).toHaveLength(4);
  });

  it('la clave es por aula: la misma cadena en otra aula es OTRO crédito, a SU cuenta', async () => {
    const forA = await credits.credit(base);
    const forB = await credits.credit({ ...base, tenantId: B });
    expect(forB.transferId).not.toBe(forA.transferId);
    expect(postCalls().map((c) => c.params['destination'])).toEqual([ACCT_A, ACCT_B]);
    // Cada aula ve solo sus asientos.
    expect(ledger(A)).toHaveLength(2);
    expect(ledger(B)).toHaveLength(2);
  });

  it('se creó la transferencia y murió el libro: el reintento ADOPTA la de Stripe, no crea otra (aunque Stripe ya olvidó la cabecera)', async () => {
    await credits.credit(base);
    // El proceso murió antes de anotar el libro.
    db.tables['modPayoutsLedgerEntry']!.length = 0;
    db.tables['modPayoutsObjectRef']!.length = 0;

    const again = await credits.credit(base);
    expect(again.created).toBe(true); // se anotó ahora
    expect(again.transferId).toBe(transfers.all[0]!['id']);
    expect(transfers.all).toHaveLength(1);
    expect(postCalls()).toHaveLength(1);
    expect(ledger()).toHaveLength(2);
  });

  it('CONTROL de la búsqueda: una transferencia con OTRA clave en el mismo grupo no se adopta', async () => {
    fake.seed({
      id: 'tr_ajena',
      object: 'transfer',
      amount: 1250,
      currency: 'eur',
      destination: ACCT_A,
      transfer_group: creditTransferGroup(A, KEY),
      metadata: { didacta_credit_key: 'payouts:credit:otra' },
    });
    transfers.all.push(fake.get('tr_ajena')!);
    const result = await credits.credit(base);
    expect(result.transferId).not.toBe('tr_ajena');
    expect(postCalls()).toHaveLength(1);
  });

  it('dos peticiones simultáneas con la misma clave → una sola transferencia y un solo par de asientos', async () => {
    const settled = await Promise.allSettled([credits.credit(base), credits.credit(base)]);
    expect(transfers.all).toHaveLength(1);
    expect(ledger()).toHaveLength(2);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const s of ok) {
      expect((s as PromiseFulfilledResult<{ transferId: string }>).value.transferId).toBe(
        transfers.all[0]!['id'],
      );
    }
  });
});

describe('crédito: sin cuenta lista no se mueve nada', () => {
  async function expectNoMoney(code: string) {
    await expect(codeOf(() => credits.credit(base))).resolves.toBe(code);
    expect(fake.calls).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
  }

  it('aula sin cuenta conectada', async () => {
    db.tables['modPayoutsAccount']!.length = 0;
    await expectNoMoney('PAYOUTS_CREDIT_NO_ACCOUNT');
  });

  it('cuenta sin acct_ todavía', async () => {
    db.update('modPayoutsAccount', { tenantId: A }, { stripeAccountId: null });
    await expectNoMoney('PAYOUTS_CREDIT_NO_ACCOUNT');
  });

  it.each([
    'NOT_CONNECTED',
    'ONBOARDING',
    'PENDING_REVIEW',
    'RESTRICTED',
    'REJECTED',
    'DISCONNECTED',
  ])('cuenta en estado %s', async (status) => {
    db.update('modPayoutsAccount', { tenantId: A }, { status });
    await expectNoMoney('PAYOUTS_CREDIT_NO_ACCOUNT');
  });

  it('cuenta cerrada', async () => {
    db.update('modPayoutsAccount', { tenantId: A }, { closedAt: new Date() });
    await expectNoMoney('PAYOUTS_CREDIT_NO_ACCOUNT');
  });

  it('CONTROL: con la cuenta READY el mismo crédito sí sale', async () => {
    await expect(credits.credit(base)).resolves.toMatchObject({ created: true });
  });

  it('nunca mueve a la cuenta de OTRA aula', async () => {
    db.tables['modPayoutsAccount']!.length = 0;
    addAccount(B, ACCT_B); // solo B tiene cuenta
    await expectNoMoney('PAYOUTS_CREDIT_NO_ACCOUNT');
  });
});

describe('crédito: fallos de Stripe', () => {
  it('saldo insuficiente de la plataforma → código propio; no se anota nada y la misma clave se puede reintentar', async () => {
    fake.failNext('/v1/transfers', {
      method: 'POST',
      status: 400,
      stripeCode: 'balance_insufficient',
      message: 'Your account has insufficient funds to cover this transfer.',
    });
    await expect(codeOf(() => credits.credit(base))).resolves.toBe(
      'PAYOUTS_CREDIT_INSUFFICIENT_PLATFORM_BALANCE',
    );
    expect(ledger()).toHaveLength(0);
    expect(transfers.all).toHaveLength(0);

    // Hay saldo después: la misma clave sale, sin haber quedado «quemada».
    await expect(credits.credit(base)).resolves.toMatchObject({ created: true });
    expect(transfers.all).toHaveLength(1);
  });

  it('error transitorio (5xx) → se propaga como reintentable y no deja asientos', async () => {
    fake.failNext('/v1/transfers', { method: 'POST', status: 500, message: 'api_error' });
    const err = await credits.credit(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformStripeApiError);
    expect((err as PlatformStripeApiError).retryable).toBe(true);
    expect(ledger()).toHaveLength(0);
    await expect(credits.credit(base)).resolves.toMatchObject({ created: true });
  });

  it('rechazo no transitorio que no es de saldo → se propaga tal cual (no se disfraza de saldo)', async () => {
    fake.failNext('/v1/transfers', {
      method: 'POST',
      status: 400,
      stripeCode: 'account_invalid',
      message: 'No such destination.',
    });
    const err = await credits.credit(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformStripeApiError);
    expect((err as PlatformStripeApiError).code).toBe('PAYOUTS_STRIPE_API_ERROR');
    expect(ledger()).toHaveLength(0);
  });

  it('Stripe contesta con otro importe/destino que el pedido → conflicto y no se anota nada', async () => {
    fake.on('POST', '/v1/transfers', (req, f) => ({
      id: f.nextId('tr'),
      object: 'transfer',
      amount: (req.params['amount'] as number) - 1,
      currency: req.params['currency'],
      destination: req.params['destination'],
      metadata: {},
    }));
    await expect(codeOf(() => credits.credit(base))).resolves.toBe(
      'PAYOUTS_CREDIT_IDEMPOTENCY_CONFLICT',
    );
    expect(ledger()).toHaveLength(0);
  });
});

describe('crédito: entradas no válidas no llegan a Stripe', () => {
  const bad: Array<[string, Partial<typeof base>]> = [
    ['importe 0', { amount: 0 }],
    ['importe negativo', { amount: -5 }],
    ['importe decimal', { amount: 12.5 }],
    ['importe NaN', { amount: Number.NaN }],
    ['importe por encima del tope del operador', { amount: 500_001 }],
    ['divisa en mayúsculas', { currency: 'EUR' }],
    ['divisa de dos letras', { currency: 'eu' }],
    ['divisa de cuatro letras', { currency: 'euro' }],
    ['clave corta', { idempotencyKey: 'corta' }],
    ['clave de 121 caracteres', { idempotencyKey: 'a'.repeat(121) }],
    ['clave con espacios', { idempotencyKey: 'clave con espacios' }],
    ['clave con salto de línea', { idempotencyKey: 'clave-larga\nsegunda' }],
    ['motivo vacío', { reason: '   ' }],
    ['motivo de 201 caracteres', { reason: 'x'.repeat(201) }],
  ];

  it.each(bad)('%s → PAYOUTS_CREDIT_INVALID', async (_name, patch) => {
    await expect(codeOf(() => credits.credit({ ...base, ...patch }))).resolves.toBe(
      'PAYOUTS_CREDIT_INVALID',
    );
    expect(fake.calls).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
  });

  it('CONTROL: en los límites exactos (importe = tope, clave de 8 y de 120, motivo de 200) sí pasa', async () => {
    await expect(
      credits.credit({ ...base, amount: 500_000, idempotencyKey: 'abcdefgh' }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      credits.credit({ ...base, idempotencyKey: 'a'.repeat(120), reason: 'x'.repeat(200) }),
    ).resolves.toMatchObject({ created: true });
  });

  it('`detail` dice qué campo falló', async () => {
    const err = await credits.credit({ ...base, amount: 0 }).catch((e: unknown) => e);
    expect((err as PayoutsError).detail).toBe('amount');
    const over = await credits.credit({ ...base, amount: 600_000 }).catch((e: unknown) => e);
    expect((over as PayoutsError).detail).toBe('amount_over_limit');
  });
});
