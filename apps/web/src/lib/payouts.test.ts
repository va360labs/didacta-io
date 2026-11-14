/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import enPagos from '@/i18n/messages/en/adminPagos.json';
import esPagos from '@/i18n/messages/es/adminPagos.json';
import ptPagos from '@/i18n/messages/pt/adminPagos.json';
import enSencillo from '@/i18n/messages/en/modoSencillo.json';
import esSencillo from '@/i18n/messages/es/modoSencillo.json';
import ptSencillo from '@/i18n/messages/pt/modoSencillo.json';
import {
  COMMON_UNSUPPORTED_COUNTRIES,
  COUNTRY_NOT_SUPPORTED_REASON,
  OTHER_COUNTRY,
  countryOptions,
  defaultCountry,
  derivePayoutsCardView,
  feePercent,
  formatStripeAmount,
  payoutsStepView,
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

  it('lista sin moneda de Stripe todavía → la de su país (un creador suizo cobra en francos, no en euros)', () => {
    expect(
      derivePayoutsCardView({
        ...base,
        settlementCurrency: 'chf',
        account: account({ status: 'READY', defaultCurrency: null, country: 'CH' }),
      }),
    ).toMatchObject({ kind: 'ready', currency: 'chf' });
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
    expect(defaultCountry(['ES', 'FR'], 'en')).toBe('ES');
    expect(defaultCountry(['FR'], 'en')).toBe('FR');
  });

  it('navegador de un país que se ofrece como «todavía no»: ESE país, no España en silencio', () => {
    // Un creador brasileño o mexicano acababa en un alta de Stripe para
    // España que iba a fallar. Con su país preseleccionado, la tarjeta enseña
    // el aviso y apaga el botón.
    expect(defaultCountry(['ES', 'FR'], 'pt-BR')).toBe('BR');
    expect(defaultCountry(['ES', 'FR'], 'es-MX')).toBe('MX');
    expect(defaultCountry(['ES', 'FR'], 'es_AR')).toBe('AR');
    const options = countryOptions(['ES', 'FR'], 'pt');
    expect(options.find((o) => o.code === defaultCountry(['ES', 'FR'], 'pt-BR'))).toMatchObject({
      supported: false,
    });
  });

  it('si el operador admite ese país, se preselecciona como admitido', () => {
    expect(defaultCountry(['ES', 'MX'], 'es-MX')).toBe('MX');
    expect(countryOptions(['ES', 'MX'], 'es').find((o) => o.code === 'MX')).toMatchObject({
      supported: true,
    });
  });

  it('manda su cuenta; después, lo que DECLARÓ en el alta de Cloud; después, el navegador', () => {
    // Cuenta (desconectada) en Francia: aunque declarara Brasil y el navegador diga México.
    expect(defaultCountry(['ES', 'FR'], 'es-MX', { account: 'FR', declared: 'BR' })).toBe('FR');
    // Sin cuenta, lo declarado, admitido o no, por encima del navegador.
    expect(defaultCountry(['ES', 'FR'], 'pt-BR', { declared: 'ES' })).toBe('ES');
    expect(defaultCountry(['ES', 'FR'], 'es-ES', { declared: 'br' })).toBe('BR');
    // Un país que no está en ninguna lista también: la tarjeta lo añade como no admitido.
    expect(defaultCountry(['ES', 'FR'], 'es-ES', { declared: 'JP' })).toBe('JP');
    // «Otro país»: se preselecciona tal cual, nunca España.
    expect(defaultCountry(['ES', 'FR'], 'es-ES', { declared: OTHER_COUNTRY })).toBe('OTHER');
    // Sin nada declarado, el navegador, como antes.
    expect(defaultCountry(['ES', 'FR'], 'pt-BR', { account: null, declared: null })).toBe('BR');
    // Un valor declarado raro no cuenta.
    expect(defaultCountry(['ES', 'FR'], 'fr-FR', { declared: 'ESPAÑA' })).toBe('FR');
  });

  it('el selector enseña lo declarado aunque no esté en ninguna lista, y «Otro país» al final', () => {
    const conJapon = countryOptions(['ES', 'FR'], 'es', { extra: ['JP', null] });
    expect(conJapon.find((o) => o.code === 'JP')).toMatchObject({
      name: 'Japón',
      supported: false,
    });
    expect(conJapon.filter((o) => o.code === 'BR')).toHaveLength(1);
    // Declarado y admitido: no se duplica ni pasa a «no admitido».
    const conEspana = countryOptions(['ES', 'FR'], 'es', { extra: ['ES'] });
    expect(conEspana.filter((o) => o.code === 'ES')).toEqual([
      { code: 'ES', name: 'España', supported: true },
    ]);
    // «Otro país» solo si se pide, al final y no admitido.
    expect(countryOptions(['ES'], 'es').some((o) => o.code === OTHER_COUNTRY)).toBe(false);
    const conOtro = countryOptions(['ES'], 'es', { extra: ['OTHER'], otherLabel: 'Otro país' });
    expect(conOtro.at(-1)).toEqual({ code: 'OTHER', name: 'Otro país', supported: false });
  });

  it('región desconocida o sin país: lo de siempre (España o el primero admitido)', () => {
    // JP no se ofrece en el selector ni como «todavía no»: no hay opción que marcar.
    expect(COMMON_UNSUPPORTED_COUNTRIES).not.toContain('JP');
    expect(defaultCountry(['ES', 'FR'], 'ja-JP')).toBe('ES');
    expect(defaultCountry(['FR', 'DE'], 'ja-JP')).toBe('FR');
    // es-419 = español de Latinoamérica: no dice qué país.
    expect(defaultCountry(['ES', 'FR'], 'es-419')).toBe('ES');
    expect(defaultCountry(['ES', 'FR'], '')).toBe('ES');
  });
});

describe('payoutsStepView: el paso «Conecta tus cobros» del modo sencillo', () => {
  const supported = ['ES', 'FR', 'GB', 'US'];

  it('país del navegador admitido → el botón de siempre', () => {
    expect(payoutsStepView({ ...base, supportedCountries: supported }, 'es-ES')).toEqual({
      kind: 'connect',
    });
  });

  it('país del navegador NO admitido y sin cuenta → el aviso, con ESE país', () => {
    expect(payoutsStepView(base, 'pt-BR')).toEqual({ kind: 'country-unsupported', country: 'BR' });
    expect(payoutsStepView(base, 'es-MX')).toEqual({ kind: 'country-unsupported', country: 'MX' });
    // Aunque no esté entre los «todavía no» del selector: tampoco se le puede pagar.
    expect(payoutsStepView(base, 'ja-JP')).toEqual({ kind: 'country-unsupported', country: 'JP' });
  });

  it('con cuenta abierta manda el país de la cuenta (el de su banco), no el del navegador', () => {
    expect(payoutsStepView({ ...base, account: account({ country: 'ES' }) }, 'pt-BR')).toEqual({
      kind: 'connect',
    });
    expect(payoutsStepView({ ...base, account: account({ country: 'MX' }) }, 'es-ES')).toEqual({
      kind: 'country-unsupported',
      country: 'MX',
    });
  });

  it('la lista de admitidos manda: si el operador admite MX, el botón', () => {
    expect(payoutsStepView({ ...base, supportedCountries: ['ES', 'MX'] }, 'es-MX')).toEqual({
      kind: 'connect',
    });
    expect(payoutsStepView({ ...base, supportedCountries: ['es', 'mx'] }, 'es-MX')).toEqual({
      kind: 'connect',
    });
  });

  it('sin cuenta manda lo DECLARADO en el alta, por encima del navegador', () => {
    expect(payoutsStepView({ ...base, declaredCountry: 'BR' }, 'es-ES')).toEqual({
      kind: 'country-unsupported',
      country: 'BR',
    });
    expect(payoutsStepView({ ...base, declaredCountry: 'ES' }, 'pt-BR')).toEqual({
      kind: 'connect',
    });
    // «Otro país» nunca se admite.
    expect(payoutsStepView({ ...base, declaredCountry: 'OTHER' }, 'es-ES')).toEqual({
      kind: 'country-unsupported',
      country: 'OTHER',
    });
    // Con cuenta, la cuenta: lo declarado ya no cuenta.
    expect(
      payoutsStepView(
        { ...base, declaredCountry: 'OTHER', account: account({ country: 'ES' }) },
        'es-ES',
      ),
    ).toEqual({ kind: 'connect' });
  });

  it('sin modo plataforma, petición fallida, país desconocido o lista vacía → el botón, como hoy', () => {
    expect(payoutsStepView(null, 'pt-BR')).toEqual({ kind: 'connect' });
    expect(payoutsStepView(undefined, 'pt-BR')).toEqual({ kind: 'connect' });
    expect(payoutsStepView(base, 'pt')).toEqual({ kind: 'connect' });
    expect(payoutsStepView(base, 'es-419')).toEqual({ kind: 'connect' });
    expect(payoutsStepView({ ...base, supportedCountries: [] }, 'pt-BR')).toEqual({
      kind: 'connect',
    });
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
      'Todavía no podemos pagar a cuentas de {country}. Mientras tanto puedes montar tu academia y tu comunidad.',
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

describe('país sin cobro: los textos no prometen lo que el aula no sabe', () => {
  // La lista de espera (avisar cuando se pueda) vive en Cloud y depende de un
  // ajuste suyo: el aula no puede prometer que avisará.
  const promesa = /avis|let you know|notify|we'll tell/i;
  const textos = [
    ['es', esPagos.payouts, esSencillo.empieza.pasos.payments],
    ['en', enPagos.payouts, enSencillo.empieza.pasos.payments],
    ['pt', ptPagos.payouts, ptSencillo.empieza.pasos.payments],
  ] as const;

  it.each(textos)('%s: ni la tarjeta ni el paso prometen avisar', (_l, pagos, paso) => {
    for (const texto of [
      pagos.countryUnsupported,
      pagos.countryUnsupportedOther,
      paso.paisNoAdmitido,
      paso.paisNoAdmitidoOtro,
    ]) {
      expect(texto).not.toMatch(promesa);
    }
  });

  it('pt: sin «de/em + país» (daría «contas de Brasil»), «escola» y no «academia»', () => {
    expect(ptPagos.payouts.countryUnsupported).toContain('no país que você informou ({country})');
    expect(ptPagos.payouts.countryUnsupported).not.toMatch(/(de|em) \{country\}/);
    expect(ptSencillo.empieza.pasos.payments.paisNoAdmitido).not.toMatch(/(de|em) \{pais\}/);
    for (const texto of [
      ptPagos.payouts.countryUnsupported,
      ptPagos.payouts.countryUnsupportedOther,
      ptSencillo.empieza.pasos.payments.paisNoAdmitido,
      ptSencillo.empieza.pasos.payments.paisNoAdmitidoOtro,
    ]) {
      expect(texto).toContain('escola');
      expect(texto).not.toMatch(/academia/i);
    }
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
