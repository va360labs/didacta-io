import { beforeEach, describe, expect, it } from 'vitest';
import {
  PayoutsInvalidAmountError,
  PayoutsInvalidCurrencyError,
  PayoutsInvalidIdempotencyKeyError,
  PayoutsLedgerIdempotencyConflictError,
} from '../src/errors.js';
import { IDEMPOTENCY_KEYS, LedgerService, type LedgerEntryInput } from '../src/ledger.service.js';
import { computeSplit, sumMinor } from '../src/money.js';

// ============================================================================
// LedgerService con un Prisma en memoria (sin BD ni red), mismo patrón que
// referrals.service.test.ts. El doble imita las DOS cosas de Postgres de las
// que depende el servicio: la unicidad de `idempotency_key` en TODA la tabla
// y que RLS solo deja ver las filas del tenant del contexto.
//
// Que la base real se comporta así (y que UPDATE/DELETE están bloqueados) lo
// prueba `apps/api/tests/integration/payouts-foundations.integration.test.ts`.
// ============================================================================

interface Row {
  id: string;
  tenantId: string;
  accountId: string;
  saleId: string | null;
  type: string;
  amount: number;
  currency: string;
  stripeObjectId: string | null;
  stripeBalanceTransactionId: string | null;
  idempotencyKey: string;
  occurredAt: Date;
  metadata: unknown;
  createdAt: Date;
}

class MockPrisma {
  rows: Row[] = [];
  /** Tenant del contexto: lo único que RLS deja ver. `null` = sin filtro. */
  visibleTenant: string | null = null;
  private seq = 0;

  private visible(): Row[] {
    return this.visibleTenant === null
      ? this.rows
      : this.rows.filter((r) => r.tenantId === this.visibleTenant);
  }

  modPayoutsLedgerEntry = {
    createMany: async ({ data, skipDuplicates }: never) => {
      const items = data as Array<Omit<Row, 'id' | 'createdAt'>>;
      let count = 0;
      for (const item of items) {
        // La unicidad mira TODAS las filas, no solo las visibles.
        if (this.rows.some((r) => r.idempotencyKey === item.idempotencyKey)) {
          if (skipDuplicates) continue;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        this.seq += 1;
        this.rows.push({ ...item, id: `entry-${this.seq}`, createdAt: new Date(1_000 + this.seq) });
        count += 1;
      }
      return { count };
    },
    findUnique: async ({ where }: never) =>
      this.visible().find(
        (r) => r.idempotencyKey === (where as { idempotencyKey: string }).idempotencyKey,
      ) ?? null,
    findMany: async ({ where }: never) => {
      const w = where as { tenantId: string; saleId: string };
      return this.visible()
        .filter((r) => r.tenantId === w.tenantId && r.saleId === w.saleId)
        .sort(
          (a, b) =>
            a.occurredAt.getTime() - b.occurredAt.getTime() ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        );
    },
    groupBy: async ({ where }: never) => {
      const w = where as { tenantId: string; accountId: string };
      const byCurrency = new Map<string, { sum: number; count: number }>();
      for (const r of this.visible()) {
        if (r.tenantId !== w.tenantId || r.accountId !== w.accountId) continue;
        const g = byCurrency.get(r.currency) ?? { sum: 0, count: 0 };
        g.sum += r.amount;
        g.count += 1;
        byCurrency.set(r.currency, g);
      }
      return [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, g]) => ({ currency, _sum: { amount: g.sum }, _count: { _all: g.count } }));
    },
  };
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CUENTA_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUENTA_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VENTA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CUANDO = new Date('2026-11-12T10:00:00Z');

function transferencia(overrides: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    tenantId: TENANT_A,
    accountId: CUENTA_A,
    saleId: VENTA,
    type: 'TRANSFER',
    amount: -9325,
    currency: 'eur',
    stripeObjectId: 'tr_1',
    idempotencyKey: IDEMPOTENCY_KEYS.transfer(VENTA),
    occurredAt: CUANDO,
    ...overrides,
  };
}

let prisma: MockPrisma;
let ledger: LedgerService;

beforeEach(() => {
  prisma = new MockPrisma();
  ledger = new LedgerService(prisma as never);
});

describe('LedgerService.append', () => {
  it('anota el asiento y lo devuelve', async () => {
    const { entry, created } = await ledger.append(transferencia({ metadata: { intento: 1 } }));

    expect(created).toBe(true);
    expect(entry).toMatchObject({
      tenantId: TENANT_A,
      accountId: CUENTA_A,
      saleId: VENTA,
      type: 'TRANSFER',
      amount: -9325,
      currency: 'eur',
      stripeObjectId: 'tr_1',
      stripeBalanceTransactionId: null,
      idempotencyKey: `payouts:transfer:${VENTA}`,
      occurredAt: CUANDO,
      metadata: { intento: 1 },
    });
    expect(prisma.rows).toHaveLength(1);
  });

  it('dos inserciones con la misma clave dejan UNA fila y la segunda dice created=false', async () => {
    const primera = await ledger.append(transferencia());
    const segunda = await ledger.append(transferencia());

    expect(primera.created).toBe(true);
    expect(segunda.created).toBe(false);
    expect(segunda.entry.id).toBe(primera.entry.id);
    expect(prisma.rows).toHaveLength(1);
  });

  it('reintentar cinco veces en paralelo sigue dejando una sola fila', async () => {
    const resultados = await Promise.all(
      Array.from({ length: 5 }, () => ledger.append(transferencia())),
    );

    expect(resultados.filter((r) => r.created)).toHaveLength(1);
    expect(prisma.rows).toHaveLength(1);
  });

  it('control: con claves distintas sí se anotan dos asientos', async () => {
    await ledger.append(transferencia());
    await ledger.append(
      transferencia({ idempotencyKey: IDEMPOTENCY_KEYS.transfer('otra-venta'), saleId: null }),
    );
    expect(prisma.rows).toHaveLength(2);
  });

  it('un reintento puede traer otra fecha u otra metadata: no es conflicto ni reescribe', async () => {
    await ledger.append(transferencia({ metadata: { intento: 1 } }));
    const { entry, created } = await ledger.append(
      transferencia({ occurredAt: new Date('2026-11-13T00:00:00Z'), metadata: { intento: 2 } }),
    );

    expect(created).toBe(false);
    expect(entry.occurredAt).toEqual(CUANDO);
    expect(entry.metadata).toEqual({ intento: 1 });
  });

  it.each([
    ['otro importe', { amount: -9000 }],
    ['otro tipo', { type: 'TRANSFER_REVERSAL' as const }],
    ['otra divisa', { currency: 'usd' }],
    ['otra cuenta', { accountId: CUENTA_B }],
    ['otra venta', { saleId: null }],
  ])('la misma clave con %s lanza y no toca el libro', async (_nombre, cambio) => {
    await ledger.append(transferencia());

    await expect(ledger.append(transferencia(cambio))).rejects.toBeInstanceOf(
      PayoutsLedgerIdempotencyConflictError,
    );
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]!.amount).toBe(-9325);
  });

  it('una clave que ya usó OTRO tenant (invisible por RLS) es conflicto, no reintento', async () => {
    prisma.visibleTenant = TENANT_B;
    await ledger.append(transferencia({ tenantId: TENANT_B, accountId: CUENTA_B }));

    prisma.visibleTenant = TENANT_A;
    const error = await ledger.append(transferencia()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PayoutsLedgerIdempotencyConflictError);
    expect((error as PayoutsLedgerIdempotencyConflictError).code).toBe(
      'PAYOUTS_LEDGER_IDEMPOTENCY_CONFLICT',
    );
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]!.tenantId).toBe(TENANT_B);
  });

  it('normaliza la divisa a minúsculas', async () => {
    const { entry } = await ledger.append(transferencia({ currency: 'EUR' }));
    expect(entry.currency).toBe('eur');
    // Y el reintento en mayúsculas sigue siendo el mismo asiento.
    expect((await ledger.append(transferencia({ currency: 'EUR' }))).created).toBe(false);
  });

  it('admite importe 0 y negativo, pero no decimales ni fuera de INTEGER', async () => {
    await expect(
      ledger.append(transferencia({ amount: 0, idempotencyKey: 'k:0' })),
    ).resolves.toMatchObject({ created: true });
    await expect(ledger.append(transferencia({ amount: 93.25 }))).rejects.toBeInstanceOf(
      PayoutsInvalidAmountError,
    );
    await expect(ledger.append(transferencia({ amount: 2_147_483_648 }))).rejects.toBeInstanceOf(
      PayoutsInvalidAmountError,
    );
    await expect(ledger.append(transferencia({ amount: -2_147_483_648 }))).rejects.toBeInstanceOf(
      PayoutsInvalidAmountError,
    );
  });

  it('rechaza divisa y clave de idempotencia no válidas sin escribir', async () => {
    await expect(ledger.append(transferencia({ currency: 'euros' }))).rejects.toBeInstanceOf(
      PayoutsInvalidCurrencyError,
    );
    await expect(ledger.append(transferencia({ idempotencyKey: '' }))).rejects.toBeInstanceOf(
      PayoutsInvalidIdempotencyKeyError,
    );
    await expect(
      ledger.append(transferencia({ idempotencyKey: 'k'.repeat(256) })),
    ).rejects.toBeInstanceOf(PayoutsInvalidIdempotencyKeyError);
    expect(prisma.rows).toHaveLength(0);
  });
});

describe('LedgerService — los cuatro asientos de una venta', () => {
  /** Venta de 100 € con tarjeta ES del sandbox: 10000 − 175 − 500 = 9325. */
  async function anotarVenta(): Promise<void> {
    const split = computeSplit({ gross: 10000, stripeFee: 175, feeBps: 500 });
    await ledger.appendMany([
      transferencia({
        type: 'SALE_GROSS',
        amount: split.gross,
        stripeObjectId: 'ch_1',
        idempotencyKey: IDEMPOTENCY_KEYS.saleEntry(VENTA, 'SALE_GROSS'),
      }),
      transferencia({
        type: 'STRIPE_FEE',
        amount: -split.stripeFee,
        stripeObjectId: 'ch_1',
        idempotencyKey: IDEMPOTENCY_KEYS.saleEntry(VENTA, 'STRIPE_FEE'),
      }),
      transferencia({
        type: 'PLATFORM_FEE',
        amount: -split.platformFee,
        idempotencyKey: IDEMPOTENCY_KEYS.saleEntry(VENTA, 'PLATFORM_FEE'),
      }),
      transferencia({ amount: -split.creatorNet }),
    ]);
  }

  it('suman cero: todo lo que correspondía al creador se le transfirió', async () => {
    await anotarVenta();

    const asientos = await ledger.listBySale(TENANT_A, VENTA);
    expect(asientos.map((a) => [a.type, a.amount])).toEqual([
      ['SALE_GROSS', 10000],
      ['STRIPE_FEE', -175],
      ['PLATFORM_FEE', -500],
      ['TRANSFER', -9325],
    ]);
    expect(sumMinor(asientos.map((a) => a.amount))).toBe(0n);
    expect(await ledger.balanceByAccount(TENANT_A, CUENTA_A)).toEqual([
      { currency: 'eur', total: 0n, entries: 4 },
    ]);
  });

  it('anotar la venta entera dos veces no duplica ningún asiento', async () => {
    await anotarVenta();
    await anotarVenta();
    expect(prisma.rows).toHaveLength(4);
  });

  it('las claves de la venta son distintas entre sí y estables', () => {
    const claves = [
      IDEMPOTENCY_KEYS.saleEntry(VENTA, 'SALE_GROSS'),
      IDEMPOTENCY_KEYS.saleEntry(VENTA, 'STRIPE_FEE'),
      IDEMPOTENCY_KEYS.saleEntry(VENTA, 'PLATFORM_FEE'),
      IDEMPOTENCY_KEYS.transfer(VENTA),
    ];
    expect(new Set(claves).size).toBe(4);
    expect(claves[0]).toBe(`payouts:sale:${VENTA}:sale_gross`);
  });
});

describe('IDEMPOTENCY_KEYS — las claves del plan, literales', () => {
  it('coinciden con las que se envían a Stripe', () => {
    expect(IDEMPOTENCY_KEYS.transfer('S')).toBe('payouts:transfer:S');
    expect(IDEMPOTENCY_KEYS.refund('R')).toBe('payouts:refund:R');
    expect(IDEMPOTENCY_KEYS.reversal('R')).toBe('payouts:reversal:R');
    expect(IDEMPOTENCY_KEYS.disputeReversal('D')).toBe('payouts:reversal:dispute:D');
    expect(IDEMPOTENCY_KEYS.debtRecovery('X', 2)).toBe('payouts:debt-recovery:X:2');
  });
});

describe('LedgerService.balanceByAccount', () => {
  it('separa por divisa y no mezcla cuentas ni tenants', async () => {
    await ledger.append(transferencia({ amount: 9325, type: 'SALE_GROSS', idempotencyKey: 'k:1' }));
    await ledger.append(
      transferencia({ amount: 9180, currency: 'usd', type: 'SALE_GROSS', idempotencyKey: 'k:2' }),
    );
    await ledger.append(transferencia({ amount: -325, type: 'STRIPE_FEE', idempotencyKey: 'k:3' }));
    await ledger.append(
      transferencia({
        tenantId: TENANT_B,
        accountId: CUENTA_B,
        amount: 777,
        type: 'SALE_GROSS',
        idempotencyKey: 'k:4',
      }),
    );

    expect(await ledger.balanceByAccount(TENANT_A, CUENTA_A)).toEqual([
      { currency: 'eur', total: 9000n, entries: 2 },
      { currency: 'usd', total: 9180n, entries: 1 },
    ]);
    expect(await ledger.balanceByAccount(TENANT_B, CUENTA_B)).toEqual([
      { currency: 'eur', total: 777n, entries: 1 },
    ]);
  });

  it('una cuenta sin asientos no tiene saldos', async () => {
    expect(await ledger.balanceByAccount(TENANT_A, CUENTA_A)).toEqual([]);
  });

  it('el total es bigint y aguanta sumas por encima de lo que cabe en la columna', async () => {
    for (let i = 0; i < 3; i += 1) {
      await ledger.append(
        transferencia({ amount: 2_000_000_000, type: 'ADJUSTMENT', idempotencyKey: `g:${i}` }),
      );
    }
    const [saldo] = await ledger.balanceByAccount(TENANT_A, CUENTA_A);
    expect(saldo!.total).toBe(6_000_000_000n);
    expect(typeof saldo!.total).toBe('bigint');
  });

  it('una suma que ya no es un entero exacto se rechaza en vez de redondearse', async () => {
    prisma.modPayoutsLedgerEntry.groupBy = (async () => [
      { currency: 'eur', _sum: { amount: 2 ** 53 }, _count: { _all: 1 } },
    ]) as never;
    await expect(ledger.balanceByAccount(TENANT_A, CUENTA_A)).rejects.toBeInstanceOf(
      PayoutsInvalidAmountError,
    );
  });
});
