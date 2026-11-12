/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import { DEFAULT_FEE_BPS, MAX_FEE_BPS, stripeKeyLivemode } from '@didacta/mod-payouts';

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
  });
}

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
