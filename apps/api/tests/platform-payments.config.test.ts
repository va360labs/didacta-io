/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_BALANCE,
  DEFAULT_SUPPORTED_COUNTRIES,
  PlatformPaymentsConfigError,
  loadPlatformPaymentsConfig,
  type PlatformPaymentsEnabled,
} from '../src/modules/payouts/platform-payments.config';

/**
 * Variables `PAYMENTS_PLATFORM_*`: el interruptor del modo en que la
 * plataforma cobra.
 *
 * Lo que este fichero protege, por orden de importancia:
 *  1. Sin la clave, el modo está APAGADO pase lo que pase con el resto: una
 *     instalación Community no puede romperse por una variable suelta.
 *  2. Con la clave y sin secreto de webhook, el arranque falla con un mensaje
 *     que dice qué falta.
 *  3. Ningún mensaje de error repite una clave ni un secreto.
 *
 * Las claves y secretos son cadenas de test con la forma de los reales.
 */

const CLAVE = 'sk_test_inventada0000';
const SECRETO_1 = 'whsec_test_plataforma_0001';
const SECRETO_2 = 'whsec_test_conectadas_0002';

function encendido(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: CLAVE,
    PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: SECRETO_1,
    ...extra,
  };
}

function cargar(env: NodeJS.ProcessEnv): PlatformPaymentsEnabled {
  const config = loadPlatformPaymentsConfig(env);
  if (!config.enabled) throw new Error('se esperaba el modo plataforma encendido');
  return config;
}

function errorDe(env: NodeJS.ProcessEnv): PlatformPaymentsConfigError {
  try {
    loadPlatformPaymentsConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(PlatformPaymentsConfigError);
    return err as PlatformPaymentsConfigError;
  }
  throw new Error('se esperaba PlatformPaymentsConfigError');
}

describe('modo plataforma APAGADO (toda Community)', () => {
  it('sin ninguna variable', () => {
    expect(loadPlatformPaymentsConfig({})).toEqual({ enabled: false });
  });

  it('con la clave vacía o en blanco (plantilla del .env: `VARIABLE=`)', () => {
    expect(loadPlatformPaymentsConfig({ PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: '' })).toEqual({
      enabled: false,
    });
    expect(loadPlatformPaymentsConfig({ PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: '   ' })).toEqual({
      enabled: false,
    });
  });

  it('sin la clave, el resto de variables ni se miran: basura incluida, no lanza', () => {
    expect(
      loadPlatformPaymentsConfig({
        PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: 'no-es-un-secreto',
        PAYMENTS_PLATFORM_DEFAULT_FEE_BPS: 'cinco',
        PAYMENTS_PLATFORM_LOSSES_COLLECTOR: 'nadie',
        PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES: 'España',
        PAYMENTS_PLATFORM_PAYOUT_INTERVAL: 'nunca',
        PAYMENTS_PLATFORM_MIN_BALANCE: '???',
        PAYMENTS_PLATFORM_ACCOUNTS_API: 'v9',
        PAYMENTS_PLATFORM_DEBT_ALERT_MINOR: '-1',
      }),
    ).toEqual({ enabled: false });
  });

  it('las claves de Stripe de instancia de siempre no lo encienden', () => {
    expect(
      loadPlatformPaymentsConfig({
        STRIPE_SECRET_KEY: CLAVE,
        STRIPE_WEBHOOK_SECRET: SECRETO_1,
        SUBSCRIPTIONS_WEBHOOK_SECRET: SECRETO_2,
      }),
    ).toEqual({ enabled: false });
  });
});

describe('modo plataforma ENCENDIDO — valores por defecto del plan', () => {
  it('con clave y un secreto, el resto sale de los valores por defecto', () => {
    expect(cargar(encendido())).toEqual({
      enabled: true,
      secretKey: CLAVE,
      livemode: false,
      webhookSecrets: [SECRETO_1],
      defaultFeeBps: 500,
      lossesCollector: 'stripe',
      supportedCountries: DEFAULT_SUPPORTED_COUNTRIES,
      payout: {
        interval: 'weekly',
        weeklyDay: 'monday',
        delayDays: 7,
        minBalance: { eur: 5000, usd: 5000, gbp: 5000 },
      },
      accountsApi: 'v2',
      displayName: 'Didacta',
      debtAlertMinor: 10000,
      // E6: lo decidido por el dueño — el operador devuelve su 5 % en
      // proporción; la comisión de la tarjeta y la disputa perdida, el creador;
      // y la tasa de una disputa GANADA (Stripe no la devuelve), también.
      lossPolicy: {
        refundPlatformFee: true,
        refundCardFeeBearer: 'creator',
        disputeLossBearer: 'creator',
        disputeWonFeeBearer: 'creator',
      },
      operatorAlertEmail: null,
      // Condiciones legales: por defecto se retienen las transferencias sin
      // datos fiscales, y sin datos del emisor no se factura.
      taxProfileRequired: true,
      invoicing: null,
    });
  });

  it('facturas: con los datos del emisor completos se factura (NIF y NIF-IVA validados)', () => {
    const config = cargar(
      encendido({
        PAYMENTS_PLATFORM_INVOICE_ISSUER_NAME: 'VA360 LABS, S.L.',
        PAYMENTS_PLATFORM_INVOICE_ISSUER_TAX_ID: 'B24805335',
        PAYMENTS_PLATFORM_INVOICE_ISSUER_VAT_ID: 'ESB24805335',
        PAYMENTS_PLATFORM_INVOICE_ISSUER_ADDRESS_LINE1: 'C/ Juan José Sánchez Rodríguez, 24',
        PAYMENTS_PLATFORM_INVOICE_ISSUER_POSTAL_CODE: '11630',
        PAYMENTS_PLATFORM_INVOICE_ISSUER_CITY: 'Arcos de la Frontera',
        PAYMENTS_PLATFORM_INVOICE_ISSUER_REGION: 'Cádiz',
        PAYMENTS_PLATFORM_INVOICE_ISSUER_EMAIL: 'hola@didacta.io',
        PAYMENTS_PLATFORM_TAX_PROFILE_REQUIRED: 'false',
      }),
    );
    expect(config).toMatchObject({
      taxProfileRequired: false,
      invoicing: {
        issuer: {
          name: 'VA360 LABS, S.L.',
          taxId: 'B24805335',
          vatId: 'ESB24805335',
          address: {
            line1: 'C/ Juan José Sánchez Rodríguez, 24',
            postalCode: '11630',
            city: 'Arcos de la Frontera',
            region: 'Cádiz',
          },
          country: 'ES',
          email: 'hola@didacta.io',
        },
        seriesPrefix: 'DC',
        serviceName: 'Didacta Cloud',
      },
    });
  });

  it('facturas: datos del emisor a medias o con un NIF que no vale → no arranca', () => {
    expect(() =>
      loadPlatformPaymentsConfig(
        encendido({ PAYMENTS_PLATFORM_INVOICE_ISSUER_NAME: 'VA360 LABS, S.L.' }),
      ),
    ).toThrow(/PAYMENTS_PLATFORM_INVOICE_ISSUER_TAX_ID/);
    expect(() =>
      loadPlatformPaymentsConfig(
        encendido({
          PAYMENTS_PLATFORM_INVOICE_ISSUER_NAME: 'VA360 LABS, S.L.',
          PAYMENTS_PLATFORM_INVOICE_ISSUER_TAX_ID: 'B24805336',
          PAYMENTS_PLATFORM_INVOICE_ISSUER_ADDRESS_LINE1: 'Calle',
          PAYMENTS_PLATFORM_INVOICE_ISSUER_POSTAL_CODE: '11630',
          PAYMENTS_PLATFORM_INVOICE_ISSUER_CITY: 'Arcos',
        }),
      ),
    ).toThrow(/no es un NIF español válido/);
    expect(() =>
      loadPlatformPaymentsConfig(encendido({ PAYMENTS_PLATFORM_INVOICE_SERIES: 'dc-1' })),
    ).toThrow(/PAYMENTS_PLATFORM_INVOICE_SERIES/);
  });

  it('E6: la política de devoluciones y el correo de alertas son configurables', () => {
    const config = cargar(
      encendido({
        PAYMENTS_PLATFORM_REFUND_PLATFORM_FEE: 'none',
        PAYMENTS_PLATFORM_REFUND_CARD_FEE_BEARER: 'platform',
        PAYMENTS_PLATFORM_DISPUTE_LOSS_BEARER: 'platform',
        PAYMENTS_PLATFORM_DISPUTE_WON_FEE_BEARER: 'platform',
        PAYMENTS_PLATFORM_OPERATOR_ALERT_EMAIL: 'cobros@example.com',
      }),
    ) as Extract<ReturnType<typeof cargar>, { enabled: true }>;
    expect(config.lossPolicy).toEqual({
      refundPlatformFee: false,
      refundCardFeeBearer: 'platform',
      disputeLossBearer: 'platform',
      disputeWonFeeBearer: 'platform',
    });
    expect(config.operatorAlertEmail).toBe('cobros@example.com');
    expect(() => cargar(encendido({ PAYMENTS_PLATFORM_REFUND_CARD_FEE_BEARER: 'alumno' }))).toThrow(
      /PAYMENTS_PLATFORM_REFUND_CARD_FEE_BEARER/,
    );
    expect(() =>
      cargar(encendido({ PAYMENTS_PLATFORM_OPERATOR_ALERT_EMAIL: 'no-es-un-correo' })),
    ).toThrow(/PAYMENTS_PLATFORM_OPERATOR_ALERT_EMAIL/);
  });

  it('tasa de una disputa ganada: por defecto el creador; «platform» aceptado; otro valor no arranca', () => {
    const bearer = (value?: string) =>
      cargar(encendido({ PAYMENTS_PLATFORM_DISPUTE_WON_FEE_BEARER: value })).lossPolicy
        .disputeWonFeeBearer;
    expect(bearer(undefined)).toBe('creator');
    // Vacía en el `.env` = sin definir = por defecto.
    expect(bearer('')).toBe('creator');
    expect(bearer('platform')).toBe('platform');
    expect(bearer('creator')).toBe('creator');
    expect(() => cargar(encendido({ PAYMENTS_PLATFORM_DISPUTE_WON_FEE_BEARER: 'alumno' }))).toThrow(
      /PAYMENTS_PLATFORM_DISPUTE_WON_FEE_BEARER: debe ser uno de: creator, platform/,
    );
  });

  it('la lista de países por defecto: ES, UE/EEE, GB, CH, US y CA; sin Latinoamérica', () => {
    for (const admitido of ['ES', 'FR', 'DE', 'IT', 'PT', 'NO', 'GB', 'CH', 'US', 'CA']) {
      expect(DEFAULT_SUPPORTED_COUNTRIES, admitido).toContain(admitido);
    }
    for (const fuera of ['MX', 'BR', 'AR', 'CO', 'CL', 'PE']) {
      expect(DEFAULT_SUPPORTED_COUNTRIES, fuera).not.toContain(fuera);
    }
    expect(new Set(DEFAULT_SUPPORTED_COUNTRIES).size).toBe(DEFAULT_SUPPORTED_COUNTRIES.length);
    expect(DEFAULT_MIN_BALANCE).toEqual({ eur: 5000, usd: 5000, gbp: 5000 });
  });

  it('livemode sale del prefijo de la clave', () => {
    expect(cargar(encendido()).livemode).toBe(false);
    expect(
      cargar(encendido({ PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'rk_live_claveInventada0000' }))
        .livemode,
    ).toBe(true);
  });

  it('el resultado está congelado', () => {
    const config = cargar(encendido());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.webhookSecrets)).toBe(true);
    expect(Object.isFrozen(config.payout.minBalance)).toBe(true);
  });
});

describe('modo plataforma ENCENDIDO — valores propios', () => {
  it('varios secretos separados por comas, recortados y sin repetir', () => {
    const config = cargar(
      encendido({
        PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: ` ${SECRETO_1} , ${SECRETO_2},${SECRETO_1}, `,
      }),
    );
    expect(config.webhookSecrets).toEqual([SECRETO_1, SECRETO_2]);
  });

  it('lee todas las variables', () => {
    const config = cargar(
      encendido({
        PAYMENTS_PLATFORM_DEFAULT_FEE_BPS: '300',
        PAYMENTS_PLATFORM_LOSSES_COLLECTOR: 'application',
        PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES: 'es, fr ,GB',
        PAYMENTS_PLATFORM_PAYOUT_INTERVAL: 'monthly',
        PAYMENTS_PLATFORM_PAYOUT_WEEKLY_DAY: 'friday',
        PAYMENTS_PLATFORM_PAYOUT_DELAY_DAYS: '14',
        PAYMENTS_PLATFORM_MIN_BALANCE: 'EUR:10000, usd:2500',
        PAYMENTS_PLATFORM_ACCOUNTS_API: 'v1',
        PAYMENTS_PLATFORM_DISPLAY_NAME: 'Academia Cloud',
        PAYMENTS_PLATFORM_DEBT_ALERT_MINOR: '50000',
      }),
    );
    expect(config).toMatchObject({
      defaultFeeBps: 300,
      lossesCollector: 'application',
      supportedCountries: ['ES', 'FR', 'GB'],
      payout: {
        interval: 'monthly',
        weeklyDay: 'friday',
        delayDays: 14,
        minBalance: { eur: 10000, usd: 2500 },
      },
      accountsApi: 'v1',
      displayName: 'Academia Cloud',
      debtAlertMinor: 50000,
    });
  });

  it('comisión 0 y 3000 son los extremos válidos', () => {
    expect(cargar(encendido({ PAYMENTS_PLATFORM_DEFAULT_FEE_BPS: '0' })).defaultFeeBps).toBe(0);
    expect(cargar(encendido({ PAYMENTS_PLATFORM_DEFAULT_FEE_BPS: '3000' })).defaultFeeBps).toBe(
      3000,
    );
  });

  it('una variable opcional vacía cae a su valor por defecto', () => {
    const config = cargar(
      encendido({
        PAYMENTS_PLATFORM_DEFAULT_FEE_BPS: '',
        PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES: '  ',
        PAYMENTS_PLATFORM_DISPLAY_NAME: '',
      }),
    );
    expect(config.defaultFeeBps).toBe(500);
    expect(config.supportedCountries).toEqual(DEFAULT_SUPPORTED_COUNTRIES);
    expect(config.displayName).toBe('Didacta');
  });
});

describe('modo plataforma ENCENDIDO — errores al arrancar', () => {
  it('clave sin secreto de webhook: error claro que nombra las dos variables', () => {
    const error = errorDe({ PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: CLAVE });
    expect(error.message).toContain('PAYMENTS_PLATFORM_STRIPE_SECRET_KEY');
    expect(error.message).toContain('PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS');
    expect(error.message).toContain('secreto del webhook');
    expect(error.message).not.toContain(CLAVE);
  });

  it('clave con el secreto vacío es lo mismo que sin secreto', () => {
    const error = errorDe(encendido({ PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: '  ' }));
    expect(error.problems).toHaveLength(1);
    expect(error.message).toContain('PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS');
  });

  it('el secreto del webhook de siempre (STRIPE_WEBHOOK_SECRET) no vale de respaldo', () => {
    const error = errorDe({
      PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: CLAVE,
      STRIPE_WEBHOOK_SECRET: SECRETO_1,
    });
    expect(error.message).toContain('PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS');
  });

  it('una clave que no es de Stripe no se repite en el error', () => {
    const mala = 'pk_test_estoEsUnaClavePublicable';
    const error = errorDe(encendido({ PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: mala }));
    expect(error.message).toContain('PAYMENTS_PLATFORM_STRIPE_SECRET_KEY');
    expect(error.message).not.toContain(mala);
  });

  it('un secreto mal formado no se repite en el error', () => {
    const malo = 'secreto-sin-prefijo-0001';
    const error = errorDe(
      encendido({ PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: `${SECRETO_1},${malo}` }),
    );
    expect(error.message).toContain('PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS');
    expect(error.message).not.toContain(malo);
    expect(error.message).not.toContain(SECRETO_1);
  });

  it.each([
    ['PAYMENTS_PLATFORM_DEFAULT_FEE_BPS', '3001'],
    ['PAYMENTS_PLATFORM_DEFAULT_FEE_BPS', '-1'],
    ['PAYMENTS_PLATFORM_DEFAULT_FEE_BPS', '5.5'],
    ['PAYMENTS_PLATFORM_DEFAULT_FEE_BPS', '5%'],
    ['PAYMENTS_PLATFORM_LOSSES_COLLECTOR', 'platform'],
    ['PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES', 'ES,ESP'],
    ['PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES', ',,'],
    ['PAYMENTS_PLATFORM_PAYOUT_INTERVAL', 'yearly'],
    ['PAYMENTS_PLATFORM_PAYOUT_WEEKLY_DAY', 'lunes'],
    ['PAYMENTS_PLATFORM_PAYOUT_DELAY_DAYS', '366'],
    ['PAYMENTS_PLATFORM_PAYOUT_DELAY_DAYS', 'siete'],
    ['PAYMENTS_PLATFORM_MIN_BALANCE', 'eur=5000'],
    ['PAYMENTS_PLATFORM_MIN_BALANCE', 'euro:5000'],
    ['PAYMENTS_PLATFORM_ACCOUNTS_API', 'v3'],
    ['PAYMENTS_PLATFORM_DEBT_ALERT_MINOR', '-5'],
  ])('%s=%s aborta el arranque nombrando la variable', (variable, valor) => {
    const error = errorDe(encendido({ [variable]: valor }));
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain(variable);
    expect(error.message).not.toContain(CLAVE);
    expect(error.message).not.toContain(SECRETO_1);
  });

  it('varios fallos a la vez se listan todos', () => {
    const error = errorDe(
      encendido({
        PAYMENTS_PLATFORM_DEFAULT_FEE_BPS: '9999',
        PAYMENTS_PLATFORM_ACCOUNTS_API: 'v3',
      }),
    );
    expect(error.problems).toHaveLength(2);
    expect(error.message).toContain('PAYMENTS_PLATFORM_DEFAULT_FEE_BPS');
    expect(error.message).toContain('PAYMENTS_PLATFORM_ACCOUNTS_API');
  });
});
