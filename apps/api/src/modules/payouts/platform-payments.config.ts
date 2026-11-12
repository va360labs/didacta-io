/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import {
  DEFAULT_FEE_BPS,
  DEFAULT_LOSS_POLICY,
  MAX_FEE_BPS,
  checkSpanishNif,
  checkVatId,
  stripeKeyLivemode,
  type InvoiceIssuer,
  type PayoutsLossPolicy,
} from '@didacta/mod-payouts';

/**
 * Configuración del MODO PLATAFORMA de cobros (variables `PAYMENTS_PLATFORM_*`).
 *
 * El interruptor es una sola variable: `PAYMENTS_PLATFORM_STRIPE_SECRET_KEY`.
 *
 *  - Sin ella (o vacía) el modo está APAGADO y el resto de variables ni se
 *    miran: aunque alguna traiga basura, la instalación arranca y cobra como
 *    siempre, con las claves de cada aula. Es el caso de toda Community.
 *  - Con ella el modo está ENCENDIDO y todo lo demás se valida de verdad. Lo
 *    que falte o esté mal aborta el arranque con un mensaje que nombra la
 *    variable: una plataforma que cobra dinero ajeno no arranca a medias.
 *
 * En particular, clave sin `PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS` es un
 * error: sin secreto no se puede verificar ningún evento, y se cobraría sin
 * poder entregar el acceso ni liquidar al creador.
 *
 * Los valores de las claves y de los secretos no aparecen NUNCA en un mensaje
 * de error.
 */

/** Variables que lee este fichero. */
export const PLATFORM_PAYMENTS_ENV = {
  secretKey: 'PAYMENTS_PLATFORM_STRIPE_SECRET_KEY',
  webhookSecrets: 'PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS',
  defaultFeeBps: 'PAYMENTS_PLATFORM_DEFAULT_FEE_BPS',
  lossesCollector: 'PAYMENTS_PLATFORM_LOSSES_COLLECTOR',
  supportedCountries: 'PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES',
  payoutInterval: 'PAYMENTS_PLATFORM_PAYOUT_INTERVAL',
  payoutWeeklyDay: 'PAYMENTS_PLATFORM_PAYOUT_WEEKLY_DAY',
  payoutDelayDays: 'PAYMENTS_PLATFORM_PAYOUT_DELAY_DAYS',
  minBalance: 'PAYMENTS_PLATFORM_MIN_BALANCE',
  accountsApi: 'PAYMENTS_PLATFORM_ACCOUNTS_API',
  displayName: 'PAYMENTS_PLATFORM_DISPLAY_NAME',
  debtAlertMinor: 'PAYMENTS_PLATFORM_DEBT_ALERT_MINOR',
  // E6 — quién asume qué cuando el dinero vuelve (por defecto, lo decidido
  // por el dueño: el operador devuelve su 5 % en proporción; la comisión de
  // la tarjeta no devuelta y la tasa de una disputa perdida, el creador).
  refundPlatformFee: 'PAYMENTS_PLATFORM_REFUND_PLATFORM_FEE',
  refundCardFeeBearer: 'PAYMENTS_PLATFORM_REFUND_CARD_FEE_BEARER',
  disputeLossBearer: 'PAYMENTS_PLATFORM_DISPUTE_LOSS_BEARER',
  /** Tasa de una disputa GANADA (Stripe no la devuelve): por defecto, el creador. */
  disputeWonFeeBearer: 'PAYMENTS_PLATFORM_DISPUTE_WON_FEE_BEARER',
  /** Correo del operador para las alertas de dinero (opcional). */
  operatorAlertEmail: 'PAYMENTS_PLATFORM_OPERATOR_ALERT_EMAIL',
  /**
   * ¿Se retienen las transferencias mientras el creador no complete sus datos
   * fiscales? Por defecto, sí (factura de la comisión y DAC7).
   */
  taxProfileRequired: 'PAYMENTS_PLATFORM_TAX_PROFILE_REQUIRED',
  // Factura mensual de la comisión: datos del EMISOR (el operador). Todo o
  // nada: sin nombre, NIF y domicilio no se factura (y se avisa al arrancar).
  invoiceIssuerName: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_NAME',
  invoiceIssuerTaxId: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_TAX_ID',
  invoiceIssuerVatId: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_VAT_ID',
  invoiceIssuerAddressLine1: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_ADDRESS_LINE1',
  invoiceIssuerPostalCode: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_POSTAL_CODE',
  invoiceIssuerCity: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_CITY',
  invoiceIssuerRegion: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_REGION',
  invoiceIssuerCountry: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_COUNTRY',
  invoiceIssuerEmail: 'PAYMENTS_PLATFORM_INVOICE_ISSUER_EMAIL',
  /** Prefijo de la serie (`DC` → `DC-2026-000001`, rectificativas `DCR-…`). */
  invoiceSeries: 'PAYMENTS_PLATFORM_INVOICE_SERIES',
  /** Nombre del servicio en la factura («Didacta Cloud»). */
  invoiceServiceName: 'PAYMENTS_PLATFORM_INVOICE_SERVICE_NAME',
} as const;

/**
 * Países a cuyos creadores puede pagar una plataforma española, por defecto:
 * España, el resto de la UE, los del EEE donde opera Stripe (Noruega y
 * Liechtenstein), Reino Unido, Suiza, Estados Unidos y Canadá.
 *
 * Verificado en el sandbox (2026-11-12) con ES, FR, GB, CH, US y CA. Fuera a
 * propósito: México (la cuenta se crea, pero «Funds can't be sent to accounts
 * located in MX»), Brasil y el resto de Latinoamérica (Stripe rechaza crear la
 * cuenta). Si Stripe rechaza un país de esta lista, el alta lo traduce al
 * mismo «país no admitido».
 */
export const DEFAULT_SUPPORTED_COUNTRIES: readonly string[] = [
  'ES',
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'SE',
  'NO',
  'LI',
  'GB',
  'CH',
  'US',
  'CA',
];

/** Colchón mínimo que se deja en la cuenta del creador, por divisa. */
export const DEFAULT_MIN_BALANCE: Readonly<Record<string, number>> = {
  eur: 5000,
  usd: 5000,
  gbp: 5000,
};

const PAYOUT_INTERVALS = ['daily', 'weekly', 'monthly', 'manual'] as const;
const WEEK_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type PayoutInterval = (typeof PAYOUT_INTERVALS)[number];
export type PayoutWeekDay = (typeof WEEK_DAYS)[number];

export interface PlatformPaymentsDisabled {
  readonly enabled: false;
}

export interface PlatformPaymentsEnabled {
  readonly enabled: true;
  /** Clave secreta o restringida de la cuenta de Stripe del operador. */
  readonly secretKey: string;
  /** `true` si la clave es de producción. */
  readonly livemode: boolean;
  /** Secretos `whsec_…` de los endpoints del webhook de plataforma (1 a 3). */
  readonly webhookSecrets: readonly string[];
  /** Comisión por defecto en puntos básicos, si el tenant no tiene la suya. */
  readonly defaultFeeBps: number;
  /** Quién asume las pérdidas de las cuentas conectadas. */
  readonly lossesCollector: 'stripe' | 'application';
  /** ISO 3166-1 alfa-2 en mayúsculas. */
  readonly supportedCountries: readonly string[];
  readonly payout: {
    readonly interval: PayoutInterval;
    readonly weeklyDay: PayoutWeekDay;
    readonly delayDays: number;
    /** Divisa en minúsculas → colchón en unidad mínima. */
    readonly minBalance: Readonly<Record<string, number>>;
  };
  /** API con la que se crean las cuentas conectadas. */
  readonly accountsApi: 'v2' | 'v1';
  /** Nombre del operador en los textos del creador. */
  readonly displayName: string;
  /** Deuda abierta (unidad mínima) a partir de la cual se avisa al operador. */
  readonly debtAlertMinor: number;
  /** Quién asume qué en reembolsos y disputas (E6). */
  readonly lossPolicy: PayoutsLossPolicy;
  /** Adónde van las alertas de dinero por correo. `null`: solo al log. */
  readonly operatorAlertEmail: string | null;
  /**
   * ¿Se retienen las transferencias sin datos fiscales completos? Opcional
   * para las configuraciones escritas a mano (tests de etapas anteriores):
   * ausente = no se retiene. `loadPlatformPaymentsConfig` lo fija siempre
   * (por defecto, `true`).
   */
  readonly taxProfileRequired?: boolean;
  /** Factura mensual de la comisión. `null`/ausente: no se factura. */
  readonly invoicing?: PlatformInvoicingConfig | null;
}

export interface PlatformInvoicingConfig {
  readonly issuer: InvoiceIssuer;
  readonly seriesPrefix: string;
  readonly serviceName: string;
}

export type PlatformPaymentsConfig = PlatformPaymentsDisabled | PlatformPaymentsEnabled;

/** La configuración del modo plataforma está incompleta o es inválida. */
export class PlatformPaymentsConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      'Configuración de cobros de plataforma no válida:\n' +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        `\nPara apagar el modo plataforma, deja ${PLATFORM_PAYMENTS_ENV.secretKey} sin definir.`,
    );
    this.name = 'PlatformPaymentsConfigError';
  }
}

/** Entero escrito en decimal, sin signo, sin espacios ni exponentes. */
function integerFromEnv(min: number, max: number) {
  return z
    .string()
    .regex(/^\d{1,9}$/, 'debe ser un número entero')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

const webhookSecretsSchema = z.string().transform((raw, ctx) => {
  const secrets = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (secrets.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'no contiene ningún secreto' });
    return z.NEVER;
  }
  if (secrets.some((secret) => !/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(secret))) {
    // Sin eco: aunque esté mal formado puede ser un secreto real.
    ctx.addIssue({
      code: 'custom',
      message: 'cada secreto debe empezar por whsec_ (lista separada por comas)',
    });
    return z.NEVER;
  }
  return secrets;
});

const countriesSchema = z.string().transform((raw, ctx) => {
  const countries = [
    ...new Set(
      raw
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const invalid = countries.filter((country) => !/^[A-Z]{2}$/.test(country));
  if (countries.length === 0 || invalid.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message:
        countries.length === 0
          ? 'no contiene ningún país'
          : `códigos de país no válidos: ${invalid.join(', ')}`,
    });
    return z.NEVER;
  }
  return countries;
});

const minBalanceSchema = z.string().transform((raw, ctx) => {
  const out: Record<string, number> = {};
  for (const part of raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const match = /^([A-Za-z]{3}):(\d{1,9})$/.exec(part);
    if (!match) {
      ctx.addIssue({
        code: 'custom',
        message: `«${part}» no tiene la forma divisa:importe (p. ej. eur:5000)`,
      });
      return z.NEVER;
    }
    out[match[1]!.toLowerCase()] = Number(match[2]);
  }
  return out;
});

const secretKeySchema = z.string().transform((key, ctx) => {
  try {
    stripeKeyLivemode(key);
    return key;
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'debe ser una clave secreta o restringida de Stripe (sk_… o rk_…)',
    });
    return z.NEVER;
  }
});

const enabledSchema = z.object({
  secretKey: secretKeySchema,
  webhookSecrets: webhookSecretsSchema,
  defaultFeeBps: integerFromEnv(0, MAX_FEE_BPS).default(String(DEFAULT_FEE_BPS)),
  lossesCollector: z.enum(['stripe', 'application']).default('stripe'),
  supportedCountries: countriesSchema.optional(),
  payoutInterval: z.enum(PAYOUT_INTERVALS).default('weekly'),
  payoutWeeklyDay: z.enum(WEEK_DAYS).default('monday'),
  payoutDelayDays: integerFromEnv(0, 365).default('7'),
  minBalance: minBalanceSchema.optional(),
  accountsApi: z.enum(['v2', 'v1']).default('v2'),
  displayName: z.string().max(80).default('Didacta'),
  debtAlertMinor: integerFromEnv(0, 2_147_483_647).default('10000'),
  refundPlatformFee: z.enum(['proportional', 'none']).default('proportional'),
  refundCardFeeBearer: z.enum(['creator', 'platform']).default('creator'),
  disputeLossBearer: z.enum(['creator', 'platform']).default('creator'),
  disputeWonFeeBearer: z.enum(['creator', 'platform']).default('creator'),
  operatorAlertEmail: z.string().email('debe ser un correo electrónico').optional(),
  taxProfileRequired: z.enum(['true', 'false']).default('true'),
  invoiceIssuerName: z.string().min(2).max(200).optional(),
  invoiceIssuerTaxId: z.string().max(30).optional(),
  invoiceIssuerVatId: z.string().max(20).optional(),
  invoiceIssuerAddressLine1: z.string().max(200).optional(),
  invoiceIssuerPostalCode: z.string().max(20).optional(),
  invoiceIssuerCity: z.string().max(120).optional(),
  invoiceIssuerRegion: z.string().max(120).optional(),
  invoiceIssuerCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'debe ser un código de país de dos letras')
    .default('ES'),
  invoiceIssuerEmail: z.string().email('debe ser un correo electrónico').optional(),
  invoiceSeries: z
    .string()
    .regex(/^[A-Z]{1,6}$/, 'solo letras mayúsculas (de 1 a 6)')
    .default('DC'),
  invoiceServiceName: z.string().min(2).max(80).default('Didacta Cloud'),
});

type EnvKey = keyof typeof PLATFORM_PAYMENTS_ENV;

/**
 * Valor de una variable, recortado. Cadena vacía = sin definir: la plantilla
 * del `.env` declara `VARIABLE=` y un `env_file` convierte eso en '' y no en
 * `undefined`.
 */
function read(env: NodeJS.ProcessEnv, key: EnvKey): string | undefined {
  const value = env[PLATFORM_PAYMENTS_ENV[key]]?.trim();
  return value ? value : undefined;
}

/**
 * Lee y valida la configuración del modo plataforma. Lanza
 * `PlatformPaymentsConfigError` si el modo está encendido y algo no cuadra.
 */
export function loadPlatformPaymentsConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlatformPaymentsConfig {
  if (read(env, 'secretKey') === undefined) return Object.freeze({ enabled: false });

  if (read(env, 'webhookSecrets') === undefined) {
    throw new PlatformPaymentsConfigError([
      `${PLATFORM_PAYMENTS_ENV.secretKey} está definida pero falta ` +
        `${PLATFORM_PAYMENTS_ENV.webhookSecrets}: sin el secreto del webhook no se puede ` +
        'verificar ningún evento de Stripe, y la plataforma cobraría sin poder entregar el ' +
        'acceso ni liquidar al creador.',
    ]);
  }

  const raw = Object.fromEntries(
    (Object.keys(PLATFORM_PAYMENTS_ENV) as EnvKey[]).map((key) => [key, read(env, key)]),
  );
  const parsed = enabledSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlatformPaymentsConfigError(
      parsed.error.issues.map((issue) => {
        const key = issue.path[0] as EnvKey | undefined;
        const name = key ? PLATFORM_PAYMENTS_ENV[key] : 'configuración';
        // Solo el nombre de la variable y el motivo: el VALOR no se repite.
        return `${name}: ${describeIssue(issue)}`;
      }),
    );
  }

  const data = parsed.data;
  const invoicing = invoicingFrom(data);
  return Object.freeze({
    enabled: true,
    secretKey: data.secretKey,
    livemode: stripeKeyLivemode(data.secretKey),
    webhookSecrets: Object.freeze([...data.webhookSecrets]),
    defaultFeeBps: data.defaultFeeBps,
    lossesCollector: data.lossesCollector,
    supportedCountries: Object.freeze([
      ...(data.supportedCountries ?? DEFAULT_SUPPORTED_COUNTRIES),
    ]),
    payout: Object.freeze({
      interval: data.payoutInterval,
      weeklyDay: data.payoutWeeklyDay,
      delayDays: data.payoutDelayDays,
      minBalance: Object.freeze({ ...(data.minBalance ?? DEFAULT_MIN_BALANCE) }),
    }),
    accountsApi: data.accountsApi,
    displayName: data.displayName,
    debtAlertMinor: data.debtAlertMinor,
    lossPolicy: Object.freeze({
      refundPlatformFee: data.refundPlatformFee === 'proportional',
      refundCardFeeBearer: data.refundCardFeeBearer,
      disputeLossBearer: data.disputeLossBearer,
      disputeWonFeeBearer: data.disputeWonFeeBearer,
    }),
    operatorAlertEmail: data.operatorAlertEmail ?? null,
    taxProfileRequired: data.taxProfileRequired === 'true',
    invoicing,
  });
}

/**
 * Datos del emisor de la factura: o todos los obligatorios (nombre, NIF,
 * dirección, código postal y ciudad) o ninguno. A medias es un error: se
 * emitirían facturas sin los datos que exige el RD 1619/2012.
 */
function invoicingFrom(data: z.infer<typeof enabledSchema>): PlatformInvoicingConfig | null {
  const required = {
    invoiceIssuerName: data.invoiceIssuerName,
    invoiceIssuerTaxId: data.invoiceIssuerTaxId,
    invoiceIssuerAddressLine1: data.invoiceIssuerAddressLine1,
    invoiceIssuerPostalCode: data.invoiceIssuerPostalCode,
    invoiceIssuerCity: data.invoiceIssuerCity,
  };
  const given = Object.entries(required).filter(([, value]) => value !== undefined);
  if (given.length === 0) return null;
  const problems: string[] = [];
  if (given.length < Object.keys(required).length) {
    const missing = Object.entries(required)
      .filter(([, value]) => value === undefined)
      .map(([key]) => PLATFORM_PAYMENTS_ENV[key as EnvKey]);
    problems.push(
      `faltan datos del emisor de las facturas: ${missing.join(', ')} (o todos, o ninguno)`,
    );
  }
  const country = data.invoiceIssuerCountry.toUpperCase();
  if (country === 'ES' && data.invoiceIssuerTaxId && !checkSpanishNif(data.invoiceIssuerTaxId).ok) {
    problems.push(`${PLATFORM_PAYMENTS_ENV.invoiceIssuerTaxId}: no es un NIF español válido`);
  }
  let vatId: string | null = null;
  if (data.invoiceIssuerVatId) {
    const check = checkVatId(country, data.invoiceIssuerVatId);
    if (check.ok) vatId = check.value;
    else problems.push(`${PLATFORM_PAYMENTS_ENV.invoiceIssuerVatId}: no es un NIF-IVA válido`);
  }
  if (problems.length > 0) throw new PlatformPaymentsConfigError(problems);
  return Object.freeze({
    issuer: Object.freeze({
      name: data.invoiceIssuerName!.trim(),
      taxId: data.invoiceIssuerTaxId!.toUpperCase().replace(/[\s.-]/g, ''),
      vatId,
      address: Object.freeze({
        line1: data.invoiceIssuerAddressLine1!.trim(),
        postalCode: data.invoiceIssuerPostalCode!.trim(),
        city: data.invoiceIssuerCity!.trim(),
        region: data.invoiceIssuerRegion?.trim() || null,
      }),
      country,
      email: data.invoiceIssuerEmail ?? null,
    }),
    seriesPrefix: data.invoiceSeries,
    serviceName: data.invoiceServiceName,
  });
}

/** La política por defecto, para quien construye la configuración a mano (tests). */
export const DEFAULT_PLATFORM_LOSS_POLICY: PayoutsLossPolicy = DEFAULT_LOSS_POLICY;

/** Mensaje de un fallo de zod sin el valor recibido. */
function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === 'invalid_enum_value') {
    return `debe ser uno de: ${issue.options.join(', ')}`;
  }
  if (issue.code === 'too_big') return `no puede ser mayor que ${String(issue.maximum)}`;
  if (issue.code === 'too_small') return `no puede ser menor que ${String(issue.minimum)}`;
  return issue.message;
}

let cachedConfig: PlatformPaymentsConfig | undefined;

/**
 * La configuración de ESTE proceso, leída una vez de `process.env`. Es la que
 * decide si existen las rutas de `mod.payouts` (`PayoutsModule.register()`) y
 * si el módulo entra en el registro: las dos cosas se evalúan al cargar el
 * grafo de Nest, antes de que `main.ts` valide. Si la configuración es
 * inválida, `main.ts` aborta el arranque con el mensaje bueno; aquí no se
 * lanza para no adelantarse con una traza de importación.
 */
export function getPlatformPaymentsConfig(): PlatformPaymentsConfig {
  if (cachedConfig) return cachedConfig;
  try {
    cachedConfig = loadPlatformPaymentsConfig(process.env);
  } catch {
    return Object.freeze({ enabled: false });
  }
  return cachedConfig;
}

/** Solo tests: olvida la configuración memoizada. */
export function resetPlatformPaymentsConfigForTests(): void {
  cachedConfig = undefined;
}
