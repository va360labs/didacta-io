import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PayoutsInvalidAmountError,
  PayoutsInvalidCurrencyError,
  PayoutsInvalidFeeBpsError,
} from '../src/errors.js';
import {
  MAX_FEE_BPS,
  MAX_MINOR_AMOUNT,
  computePlatformFee,
  computeProportionalReversal,
  computeSplit,
  normalizeCurrency,
  prorate,
  sumMinor,
} from '../src/money.js';

// ============================================================================
// Aritmética del dinero de mod.payouts.
//
// Los importes NO son inventados: son los que devolvió el sandbox de Stripe de
// la plataforma el 2026-11-12 (cobro y transferencia separados, comisión del
// 5 %). La tabla de abajo es la del plan, fila a fila; el fixture es la copia
// de `state.json` del sandbox, y un test comprueba que las dos dicen lo mismo.
// ============================================================================

interface Caso {
  readonly caso: string;
  readonly gross: number;
  readonly stripeFee: number;
  readonly platformFee: number;
  readonly creatorNet: number;
  readonly currency: string;
}

/** Tabla de la etapa E1 del plan (12 filas). */
const TABLA: readonly Caso[] = [
  {
    caso: 't_eur100_obo_ES',
    gross: 10000,
    stripeFee: 175,
    platformFee: 500,
    creatorNet: 9325,
    currency: 'eur',
  },
  {
    caso: 't_eur100_obo_ES_tarjetaUS',
    gross: 10000,
    stripeFee: 340,
    platformFee: 500,
    creatorNet: 9160,
    currency: 'eur',
  },
  {
    caso: 't_unica30_tarjeta_ES',
    gross: 3000,
    stripeFee: 70,
    platformFee: 150,
    creatorNet: 2780,
    currency: 'eur',
  },
  {
    caso: 't_unica100_tarjeta_GB',
    gross: 10000,
    stripeFee: 275,
    platformFee: 500,
    creatorNet: 9225,
    currency: 'eur',
  },
  {
    caso: 't_usd100_obo_US',
    gross: 10000,
    stripeFee: 320,
    platformFee: 500,
    creatorNet: 9180,
    currency: 'usd',
  },
  {
    caso: 't_gbp100_obo_GB',
    gross: 10000,
    stripeFee: 170,
    platformFee: 500,
    creatorNet: 9330,
    currency: 'gbp',
  },
  {
    caso: 't_eur100_obo_US',
    gross: 11085,
    stripeFee: 629,
    platformFee: 554,
    creatorNet: 9902,
    currency: 'usd',
  },
  {
    caso: 't_usd100_creador_ES',
    gross: 9021,
    stripeFee: 489,
    platformFee: 451,
    creatorNet: 8081,
    currency: 'eur',
  },
  {
    caso: 't_gbp100_creador_ES',
    gross: 11971,
    stripeFee: 563,
    platformFee: 599,
    creatorNet: 10809,
    currency: 'eur',
  },
  {
    caso: 't_mxn2000_creador_ES',
    gross: 9692,
    stripeFee: 524,
    platformFee: 485,
    creatorNet: 8683,
    currency: 'eur',
  },
  {
    caso: 't_brl500_creador_ES',
    gross: 8071,
    stripeFee: 440,
    platformFee: 404,
    creatorNet: 7227,
    currency: 'eur',
  },
  {
    caso: 'factura_membresia_29',
    gross: 2900,
    stripeFee: 69,
    platformFee: 145,
    creatorNet: 2686,
    currency: 'eur',
  },
];

interface FixtureSale {
  case: string;
  gross: number;
  stripeFee: number;
  feeBps: number;
  platformFee: number;
  creatorNet: number;
  currency: string;
}
interface Fixture {
  sales: FixtureSale[];
  subscriptionInvoice: FixtureSale;
  proportionalReversal: {
    gross: number;
    transferAmount: number;
    refundAmount: number;
    reversal: number;
  };
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'sandbox-2026-11-12.json'), 'utf8'),
) as Fixture;

describe('computeSplit — tabla de importes del sandbox', () => {
  it('la tabla tiene las 12 filas del plan', () => {
    expect(TABLA).toHaveLength(12);
  });

  it.each(TABLA)(
    '$caso: $gross − $stripeFee − 5 % → $creatorNet $currency',
    ({ gross, stripeFee, platformFee, creatorNet }) => {
      const split = computeSplit({ gross, stripeFee, feeBps: 500 });
      expect(split).toEqual({ gross, stripeFee, feeBpsApplied: 500, platformFee, creatorNet });
    },
  );

  it('el fixture del sandbox trae los mismos importes que la tabla del plan', () => {
    const delFixture = [...fixture.sales, fixture.subscriptionInvoice]
      .map((s) => ({
        caso: s.case,
        gross: s.gross,
        stripeFee: s.stripeFee,
        platformFee: s.platformFee,
        creatorNet: s.creatorNet,
        currency: s.currency,
      }))
      .sort((a, b) => a.caso.localeCompare(b.caso));
    const delPlan = [...TABLA].sort((a, b) => a.caso.localeCompare(b.caso));
    expect(delFixture).toEqual(delPlan);
  });

  it('cada venta del fixture se reproduce con computeSplit', () => {
    const ventas = [...fixture.sales, fixture.subscriptionInvoice];
    expect(ventas.length).toBe(12);
    for (const venta of ventas) {
      const split = computeSplit({
        gross: venta.gross,
        stripeFee: venta.stripeFee,
        feeBps: venta.feeBps,
      });
      expect(split.platformFee, venta.case).toBe(venta.platformFee);
      expect(split.creatorNet, venta.case).toBe(venta.creatorNet);
    }
  });
});

describe('computePlatformFee — redondeo al más cercano, medio hacia arriba', () => {
  it('598,55 → 599 (11971 al 5 %)', () => {
    expect(computePlatformFee(11971, 500)).toBe(599);
  });

  it('403,55 → 404 (8071 al 5 %)', () => {
    expect(computePlatformFee(8071, 500)).toBe(404);
  });

  it('el medio exacto sube: 0,5 → 1 y 1,5 → 2', () => {
    // 10 al 5 % = 0,5; 30 al 5 % = 1,5.
    expect(computePlatformFee(10, 500)).toBe(1);
    expect(computePlatformFee(30, 500)).toBe(2);
  });

  it('por debajo del medio baja: 0,45 → 0 y 554,25 → 554', () => {
    expect(computePlatformFee(9, 500)).toBe(0);
    expect(computePlatformFee(11085, 500)).toBe(554);
  });

  it('coincide con la fórmula del plan en todo el rango de comisiones', () => {
    // Control independiente de la implementación: floor((g × bps + 5000) / 10000)
    // con enteros de JS (seguro: g × bps < 2^53 en estos valores).
    for (const gross of [0, 1, 9, 10, 99, 2900, 8071, 11971, 123457, MAX_MINOR_AMOUNT]) {
      for (const bps of [0, 1, 250, 499, 500, 501, 1234, 2999, 3000]) {
        expect(computePlatformFee(gross, bps), `${gross} al ${bps}`).toBe(
          Math.floor((gross * bps + 5000) / 10000),
        );
      }
    }
  });
});

describe('computeSplit — extremos de la comisión', () => {
  it('fee_bps 0: el operador no se queda nada', () => {
    expect(computeSplit({ gross: 10000, stripeFee: 175, feeBps: 0 })).toEqual({
      gross: 10000,
      stripeFee: 175,
      feeBpsApplied: 0,
      platformFee: 0,
      creatorNet: 9825,
    });
  });

  it('fee_bps 3000 (el techo): 30 %', () => {
    expect(computeSplit({ gross: 10000, stripeFee: 175, feeBps: 3000 })).toEqual({
      gross: 10000,
      stripeFee: 175,
      feeBpsApplied: 3000,
      platformFee: 3000,
      creatorNet: 6825,
    });
  });

  it('al 3 %: 300 de comisión sobre 100 €', () => {
    expect(computeSplit({ gross: 10000, stripeFee: 175, feeBps: 300 }).platformFee).toBe(300);
  });

  it.each([-1, 3001, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rechaza fee_bps = %s',
    (feeBps) => {
      expect(() => computeSplit({ gross: 10000, stripeFee: 175, feeBps })).toThrow(
        PayoutsInvalidFeeBpsError,
      );
    },
  );

  it('el techo es 3000', () => {
    expect(MAX_FEE_BPS).toBe(3000);
  });

  it.each([
    ['gross negativo', { gross: -1, stripeFee: 0 }],
    ['gross con decimales', { gross: 100.5, stripeFee: 0 }],
    ['gross fuera de INTEGER', { gross: MAX_MINOR_AMOUNT + 1, stripeFee: 0 }],
    ['stripeFee negativa', { gross: 100, stripeFee: -1 }],
    ['stripeFee con decimales', { gross: 100, stripeFee: 1.75 }],
  ])('rechaza %s', (_nombre, importes) => {
    expect(() => computeSplit({ ...importes, feeBps: 500 })).toThrow(PayoutsInvalidAmountError);
  });

  it('un cargo minúsculo puede dejar al creador en negativo, y lo dice', () => {
    // 0,50 € con 0,49 € de comisión de Stripe y 5 %: −2 céntimos. No se
    // transfiere un negativo: quien liquida lo convierte en deuda.
    const split = computeSplit({ gross: 50, stripeFee: 49, feeBps: 500 });
    expect(split.platformFee).toBe(3);
    expect(split.creatorNet).toBe(-2);
  });
});

describe('invariante gross − stripe_fee − platform_fee = creator_net', () => {
  it('se cumple en las 12 filas de la tabla', () => {
    for (const fila of TABLA) {
      expect(fila.gross - fila.stripeFee - fila.platformFee, fila.caso).toBe(fila.creatorNet);
      const split = computeSplit({ gross: fila.gross, stripeFee: fila.stripeFee, feeBps: 500 });
      expect(split.gross - split.stripeFee - split.platformFee, fila.caso).toBe(split.creatorNet);
    }
  });

  it('se cumple en un barrido de importes, comisiones de Stripe y bps', () => {
    let comprobados = 0;
    for (let gross = 0; gross <= 200_000; gross += 1_237) {
      for (const stripeFee of [0, 25, 70, 175, 340, 629]) {
        for (const feeBps of [0, 300, 500, 1500, 3000]) {
          const split = computeSplit({ gross, stripeFee, feeBps });
          expect(split.gross - split.stripeFee - split.platformFee).toBe(split.creatorNet);
          expect(Number.isInteger(split.platformFee)).toBe(true);
          expect(split.platformFee).toBeGreaterThanOrEqual(0);
          expect(split.platformFee).toBeLessThanOrEqual(gross);
          comprobados += 1;
        }
      }
    }
    // Guarda: si el barrido no recorriera nada, lo de arriba no probaría nada.
    expect(comprobados).toBeGreaterThan(4_000);
  });

  it('no pierde precisión con el mayor importe que cabe en la columna', () => {
    // 2 147 483 647 × 3000 = 6,4e12: cabe en number, pero se calcula en bigint.
    expect(computePlatformFee(MAX_MINOR_AMOUNT, 3000)).toBe(644_245_094);
    const split = computeSplit({ gross: MAX_MINOR_AMOUNT, stripeFee: 0, feeBps: 3000 });
    expect(split.creatorNet).toBe(MAX_MINOR_AMOUNT - 644_245_094);
  });
});

describe('reversión proporcional', () => {
  it('reembolsar el 40 % de una venta de 100 € revierte 3730 de los 9325', () => {
    expect(
      computeProportionalReversal({ transferAmount: 9325, refundAmount: 4000, gross: 10000 }),
    ).toBe(3730);
  });

  it('coincide con la reversión que aceptó el sandbox', () => {
    const r = fixture.proportionalReversal;
    expect(
      computeProportionalReversal({
        transferAmount: r.transferAmount,
        refundAmount: r.refundAmount,
        gross: r.gross,
      }),
    ).toBe(r.reversal);
  });

  it('el reembolso total revierte la transferencia entera', () => {
    expect(
      computeProportionalReversal({ transferAmount: 9325, refundAmount: 10000, gross: 10000 }),
    ).toBe(9325);
  });

  it('reembolso de 0 → reversión de 0', () => {
    expect(
      computeProportionalReversal({ transferAmount: 9325, refundAmount: 0, gross: 10000 }),
    ).toBe(0);
  });

  it('redondea al más cercano: un tercio de 9325 son 3108,33 → 3108', () => {
    expect(
      computeProportionalReversal({ transferAmount: 9325, refundAmount: 3333, gross: 9999 }),
    ).toBe(3108);
  });

  it('dos parciales nunca revierten más que la transferencia', () => {
    // 3 de 5 céntimos transferidos, en dos mitades: 1,5 → 2 cada una serían 4.
    const primera = computeProportionalReversal({ transferAmount: 3, refundAmount: 5, gross: 10 });
    expect(primera).toBe(2);
    const segunda = computeProportionalReversal({
      transferAmount: 3,
      refundAmount: 5,
      gross: 10,
      alreadyReversed: primera,
    });
    expect(segunda).toBe(1);
    expect(primera + segunda).toBe(3);
  });

  it('con todo ya revertido no queda nada que revertir', () => {
    expect(
      computeProportionalReversal({
        transferAmount: 9325,
        refundAmount: 4000,
        gross: 10000,
        alreadyReversed: 9325,
      }),
    ).toBe(0);
  });

  it('rechaza reembolsar más que el bruto, un bruto 0 o un revertido imposible', () => {
    expect(() =>
      computeProportionalReversal({ transferAmount: 9325, refundAmount: 10001, gross: 10000 }),
    ).toThrow(PayoutsInvalidAmountError);
    expect(() =>
      computeProportionalReversal({ transferAmount: 0, refundAmount: 0, gross: 0 }),
    ).toThrow(PayoutsInvalidAmountError);
    expect(() =>
      computeProportionalReversal({
        transferAmount: 100,
        refundAmount: 10,
        gross: 100,
        alreadyReversed: 101,
      }),
    ).toThrow(PayoutsInvalidAmountError);
  });

  it('prorate reparte también la comisión del operador: 40 % de 500 → 200', () => {
    expect(prorate(500, 4000, 10000)).toBe(200);
  });
});

describe('sumMinor — sumas en bigint', () => {
  it('suma por encima de 2^31 y de 2^53 sin perder un céntimo', () => {
    expect(sumMinor([MAX_MINOR_AMOUNT, MAX_MINOR_AMOUNT, 2])).toBe(4_294_967_296n);
    expect(sumMinor([9_007_199_254_740_993n, 1])).toBe(9_007_199_254_740_994n);
  });

  it('admite negativos (asientos con signo) y lista vacía', () => {
    expect(sumMinor([10000, -175, -500, -9325])).toBe(0n);
    expect(sumMinor([])).toBe(0n);
  });

  it('rechaza un sumando con decimales', () => {
    expect(() => sumMinor([1.5])).toThrow(PayoutsInvalidAmountError);
  });
});

describe('normalizeCurrency', () => {
  it('pasa a minúsculas y recorta', () => {
    expect(normalizeCurrency('EUR')).toBe('eur');
    expect(normalizeCurrency(' usd ')).toBe('usd');
  });

  it.each(['', 'eu', 'euro', 'e1r', 978, null, undefined])('rechaza %s', (valor) => {
    expect(() => normalizeCurrency(valor)).toThrow(PayoutsInvalidCurrencyError);
  });
});
