/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import enPagos from '@/i18n/messages/en/adminPagos.json';
import esPagos from '@/i18n/messages/es/adminPagos.json';
import {
  COUNTRY_NOT_SUPPORTED_REASON,
  countryOptions,
  defaultCountry,
  derivePayoutsCardView,
  feePercent,
  formatStripeAmount,
  saleStatusView,
  stripeMinorToMajor,
  type PayoutsAccountDto,
  type PayoutsStatusDto,
} from './payouts';

const base: PayoutsStatusDto = {
  platform: true,
  operatorName: 'Didacta',
  mode: 'platform',
  ready: false,
  reason: 'not_connected',
  account: null,
  supportedCountries: ['ES', 'FR', 'GB', 'US'],
  feeBps: 500,
};

const account = (over: Partial<PayoutsAccountDto>): PayoutsAccountDto => ({
  status: 'ONBOARDING',
  stripeAccountId: 'acct_1Abc',
  country: 'ES',
  entityType: 'individual',
  defaultCurrency: 'eur',
  payoutsEnabled: false,
  pendingRequirement: 'bank_account',
  requirementsDeadline: null,
  disabledReason: null,
  payoutSchedule: null,
  readyAt: null,
  lastSyncedAt: null,
  ...over,
});

describe('derivePayoutsCardView: los tres estados del plan y sus variantes', () => {
  it('sin modo plataforma (la ruta no existe) → la tarjeta de claves de siempre', () => {
    expect(derivePayoutsCardView(null)).toEqual({ kind: 'own-keys' });
  });

  it('sin cuenta → «Sin conectar»', () => {
    expect(derivePayoutsCardView(base)).toEqual({ kind: 'not-connected' });
    expect(
      derivePayoutsCardView({ ...base, account: account({ status: 'DISCONNECTED' }) }),
    ).toEqual({ kind: 'not-connected' });
  });

  it('alta a medias o restringida → «Falta algo» con el dato concreto', () => {
    expect(derivePayoutsCardView({ ...base, account: account({}) })).toEqual({
      kind: 'missing',
      requirement: 'bank_account',
    });
    expect(
      derivePayoutsCardView({
        ...base,
        account: account({ status: 'RESTRICTED', pendingRequirement: null }),
      }),
    ).toEqual({ kind: 'missing', requirement: 'other' });
  });

  it('lista → «Todo listo» con divisa y calendario', () => {
    const schedule = {
      interval: 'weekly',
      weeklyDay: 'monday',
      monthlyDay: null,
      delayDays: 7,
      minimumBalance: { eur: 5000 },
    };
    expect(
      derivePayoutsCardView({
        ...base,
        account: account({ status: 'READY', payoutSchedule: schedule }),
      }),
    ).toEqual({ kind: 'ready', currency: 'eur', schedule });
  });

  it('revisión, rechazo y país que dejó de admitirse tienen su propio texto', () => {
    expect(
      derivePayoutsCardView({ ...base, account: account({ status: 'PENDING_REVIEW' }) }).kind,
    ).toBe('review');
    expect(derivePayoutsCardView({ ...base, account: account({ status: 'REJECTED' }) }).kind).toBe(
      'rejected',
    );
    expect(
      derivePayoutsCardView({
        ...base,
        account: account({
          status: 'RESTRICTED',
          country: 'MX',
          disabledReason: COUNTRY_NOT_SUPPORTED_REASON,
        }),
      }),
    ).toEqual({ kind: 'country-unsupported', country: 'MX' });
  });
});

describe('selector de país', () => {
  it('primero los admitidos; detrás los que preguntan y no se admiten (para explicar por qué)', () => {
    const options = countryOptions(['ES', 'FR'], 'es');
    expect(options.slice(0, 2).every((o) => o.supported)).toBe(true);
    expect(options.find((o) => o.code === 'MX')).toMatchObject({ supported: false });
    expect(options.find((o) => o.code === 'BR')).toMatchObject({ supported: false });
    expect(options.find((o) => o.code === 'ES')!.name).toBe('España');
  });

  it('país por defecto: el del navegador si se admite; si no, España', () => {
    expect(defaultCountry(['ES', 'FR'], 'fr-FR')).toBe('FR');
    expect(defaultCountry(['ES', 'FR'], 'es-MX')).toBe('ES');
    expect(defaultCountry(['FR'], 'en')).toBe('FR');
  });
});

describe('textos EXACTOS del plan (sección 4)', () => {
  it('español', () => {
    const p = esPagos.payouts;
    expect(p.notConnected).toBe(
      'Aún no puedes cobrar. Conecta tus cobros: son unos 5 minutos y no tienes que pegar ninguna clave.',
    );
    expect(p.connectCta).toBe('Conectar cobros');
    expect(p.missing).toBe(
      'Falta un dato para poder pagarte: {requirement}. Hasta entonces no puedes vender.',
    );
    expect(p.finishCta).toBe('Completar');
    expect(p.ready).toBe('Todo listo. Cobras en {currency} y te pagamos cada {day}.');
    expect(p.dashboardCta).toBe('Ver mis pagos en Stripe');
    expect(p.countryUnsupported).toBe(
      'Todavía no podemos pagar a cuentas de {country}. Te avisamos cuando se pueda.',
    );
  });

  it('inglés', () => {
    const p = enPagos.payouts;
    expect(p.notConnected).toBe(
      "You can't take payments yet. Connect payouts: about 5 minutes, no keys to paste.",
    );
    expect(p.connectCta).toBe('Connect payouts');
    expect(p.missing).toBe('We need one more thing before we can pay you: {requirement}.');
    expect(p.finishCta).toBe('Finish');
    expect(p.ready).toBe("All set. You're paid in {currency} every {day}.");
    expect(p.dashboardCta).toBe('See my payouts on Stripe');
  });
});

describe('«Tus ventas»: importes y estados', () => {
  it('importes de Stripe con sus decimales y en la moneda de cada venta', () => {
    expect(formatStripeAmount(9325, 'eur', 'es')).toBe('93,25 €');
    expect(formatStripeAmount(10000, 'eur', 'es')).toBe('100,00 €');
    expect(formatStripeAmount(9180, 'usd', 'en')).toBe('$91.80');
    expect(formatStripeAmount(9330, 'gbp', 'en')).toBe('£93.30');
    // HUF: Stripe lo cobra con dos decimales aunque se pague en forintos enteros.
    expect(stripeMinorToMajor(3722150, 'huf')).toBe(37221.5);
    // JPY: sin decimales en Stripe.
    expect(stripeMinorToMajor(1000, 'jpy')).toBe(1000);
    expect(stripeMinorToMajor(214977, 'MXN')).toBe(2149.77);
  });

  it('porcentaje del operador desde puntos básicos', () => {
    expect(feePercent(500, 'es')).toBe('5');
    expect(feePercent(250, 'es')).toBe('2,5');
    expect(feePercent(250, 'en')).toBe('2.5');
  });

  it('cada estado tiene su texto en lenguaje llano, sin jerga', () => {
    const cases = [
      [{ status: 'AWAITING_FEE', reason: null }, 'calculating'],
      [{ status: 'READY', reason: null }, 'onTheWay'],
      [{ status: 'TRANSFERRED', reason: null }, 'sent'],
      [{ status: 'SETTLED_NETTED', reason: null }, 'netted'],
      [{ status: 'HELD', reason: 'account_not_ready' }, 'heldAccount'],
      [{ status: 'HELD', reason: 'transfer_rejected' }, 'heldRetry'],
      [{ status: 'HELD', reason: 'charge_refunded' }, 'refunded'],
      [{ status: 'HELD', reason: 'charge_disputed' }, 'disputed'],
      [{ status: 'FAILED', reason: 'negative_net' }, 'review'],
    ] as const;
    for (const [sale, key] of cases) {
      expect(saleStatusView(sale).key).toBe(key);
      expect(esPagos.payouts.sales.status[key]).toBeTruthy();
      expect(enPagos.payouts.sales.status[key]).toBeTruthy();
    }
    const jerga = /transfer|balance|payout|stripe|charge|liquidaci|netted/i;
    for (const texts of [esPagos.payouts.sales, enPagos.payouts.sales]) {
      for (const value of Object.values(texts.status)) expect(value).not.toMatch(jerga);
      for (const key of ['colCardFee', 'colYouGet', 'colArrives', 'noticeHeld', 'empty'] as const) {
        expect(texts[key]).not.toMatch(jerga);
      }
    }
  });

  it('textos del plan (sección 4): comisión de la tarjeta, el % del operador y lo que recibes', () => {
    expect(esPagos.payouts.sales.colCardFee).toBe('Comisión de la tarjeta');
    expect(esPagos.payouts.sales.colOperatorFee).toBe('{percent} % {operator}');
    expect(esPagos.payouts.sales.colYouGet).toBe('Lo que recibes');
    expect(esPagos.payouts.sales.colArrives).toBe('Cuándo llega');
    expect(Object.keys(enPagos.payouts.sales).sort()).toEqual(
      Object.keys(esPagos.payouts.sales).sort(),
    );
    expect(Object.keys(enPagos.payouts.sales.status).sort()).toEqual(
      Object.keys(esPagos.payouts.sales.status).sort(),
    );
  });
});
