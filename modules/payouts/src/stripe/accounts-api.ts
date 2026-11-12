/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PayoutsCountryUnsupportedError, PlatformStripeApiError } from '../errors.js';
import {
  PLATFORM_STRIPE_V2_API_VERSION,
  type PlatformStripeClient,
  type StripeParams,
} from './platform-stripe.client.js';

/**
 * Cuentas conectadas del creador sobre la API de Stripe.
 *
 * Dos formas de CREAR la cuenta, elegidas por `PAYMENTS_PLATFORM_ACCOUNTS_API`:
 *
 *  - **v2** (por defecto) — `POST /v2/core/accounts` con panel Express,
 *    configuraciones `merchant` (cobrar con tarjeta, `on_behalf_of`) y
 *    `recipient` (recibir transferencias), comisiones a cargo de la plataforma
 *    y pérdidas según la variable. Es vista previa.
 *  - **v1** — `POST /v1/accounts` con `controller`, la alternativa probada en
 *    `tools/payments-sandbox/02-cuentas-v2-paises.mjs`. Ojo: con la versión
 *    fijada de v1 (`2026-10-28.endive`) Stripe exige que la plataforma asuma
 *    las pérdidas si el panel es Express («With a dashboard type of `express`,
 *    the Connect application must control losses»); con la de vista previa
 *    acepta `losses.payments: stripe`. Por eso el alta v1 viaja con la versión
 *    de vista previa (verificado en el sandbox el 2026-11-12).
 *
 * Todo lo DEMÁS es igual para las dos, y va por v1, que es estable:
 *
 *  - leer la cuenta (`GET /v1/accounts/{id}`) — funciona también con las
 *    cuentas creadas por v2 y trae `details_submitted`, que v2 no expone. El
 *    estado se deriva siempre de esta lectura (`deriveStatus`).
 *  - enlace de alta (`POST /v1/account_links`), enlace al panel Express
 *    (`POST /v1/accounts/{id}/login_links`) y calendario de pagos
 *    (`POST /v1/balance_settings` con `Stripe-Account`).
 */

export type AccountsApiFlavor = 'v2' | 'v1';
export type AccountEntityType = 'individual' | 'company';
export const ACCOUNT_ENTITY_TYPES: readonly AccountEntityType[] = ['individual', 'company'];

/** Merchant Category Code de «Educational Services». */
export const EDUCATION_MCC = '8299';

/** Lo que se sabe del creador al pulsar «Conectar cobros». */
export interface CreateConnectedAccountInput {
  /** ISO 3166-1 alfa-2 en mayúsculas. */
  readonly country: string;
  readonly entityType: AccountEntityType;
  /** Correo del administrador que conecta. */
  readonly email: string;
  /** Nombre del aula. */
  readonly displayName: string;
  /** `https://<dominio del aula>`. Se omite si no es un dominio público. */
  readonly businessUrl?: string | null;
  readonly productDescription?: string | null;
  /** Ya saneado (`sanitizeStatementDescriptor`); `null` = que lo pida Stripe. */
  readonly statementDescriptor?: string | null;
  /** Divisa por defecto (minúsculas). `null` = la que decida Stripe. */
  readonly currency?: string | null;
  /** Idioma del alta alojada (`es-ES`, `en-US`…). */
  readonly locale?: string | null;
  readonly lossesCollector: 'stripe' | 'application';
  readonly metadata: Readonly<Record<string, string>>;
  /** Misma clave en un reintento = la misma cuenta (Stripe la recuerda 24 h). */
  readonly idempotencyKey: string;
}

export interface CreatedConnectedAccount {
  readonly id: string;
  readonly livemode: boolean;
}

/** Capacidad v1 tal como la devuelve Stripe (`active`, `inactive`, `pending`). */
export type StripeCapabilityStatus = 'active' | 'inactive' | 'pending' | (string & {});

/** Requisitos de una cuenta en la vista v1. */
export interface StripeAccountRequirements {
  readonly currently_due?: readonly string[] | null;
  readonly eventually_due?: readonly string[] | null;
  readonly past_due?: readonly string[] | null;
  readonly pending_verification?: readonly string[] | null;
  readonly disabled_reason?: string | null;
  /** Segundos Unix. */
  readonly current_deadline?: number | null;
  readonly errors?: ReadonlyArray<{
    readonly code?: string;
    readonly reason?: string;
    readonly requirement?: string;
  }> | null;
}

/** Calendario de pagos al banco en la vista v1 (`settings.payouts.schedule`). */
export interface StripePayoutScheduleV1 {
  readonly interval?: string | null;
  readonly weekly_anchor?: string | null;
  readonly weekly_payout_days?: readonly string[] | null;
  readonly monthly_anchor?: number | null;
  readonly delay_days?: number | null;
}

/**
 * La parte de `GET /v1/accounts/{id}` que usa el dominio. Tipado contra las
 * respuestas reales grabadas en `tests/fixtures/accounts-2026-11-12.json`.
 */
export interface StripeConnectedAccount {
  readonly id: string;
  readonly object?: string;
  readonly country?: string | null;
  readonly default_currency?: string | null;
  readonly business_type?: string | null;
  readonly details_submitted?: boolean | null;
  readonly charges_enabled?: boolean | null;
  readonly payouts_enabled?: boolean | null;
  readonly capabilities?: Readonly<Record<string, StripeCapabilityStatus>> | null;
  readonly requirements?: StripeAccountRequirements | null;
  readonly controller?: {
    readonly fees?: { readonly payer?: string | null } | null;
    readonly losses?: { readonly payments?: string | null } | null;
    readonly stripe_dashboard?: { readonly type?: string | null } | null;
  } | null;
  readonly settings?: {
    readonly payouts?: { readonly schedule?: StripePayoutScheduleV1 | null } | null;
  } | null;
}

/** `POST /v1/balance_settings`, la parte de pagos al banco. */
export interface StripeBalanceSettings {
  readonly object?: string;
  readonly payments?: {
    readonly payouts?: {
      readonly minimum_balance_by_currency?: Readonly<Record<string, number>> | null;
      readonly schedule?: {
        readonly interval?: string | null;
        readonly weekly_payout_days?: readonly string[] | null;
        readonly monthly_payout_days?: readonly number[] | null;
      } | null;
      readonly status?: string | null;
    } | null;
    readonly settlement_timing?: { readonly delay_days?: number | null } | null;
  } | null;
}

export interface UpdateBalanceSettingsInput {
  readonly interval: 'daily' | 'weekly' | 'monthly' | 'manual';
  /** Solo con `weekly`. */
  readonly weeklyDay?: string;
  /** Solo con `monthly` (1–31). */
  readonly monthlyDay?: number;
  /** Colchón por divisa en unidad mínima. */
  readonly minimumBalanceByCurrency?: Readonly<Record<string, number>>;
  /**
   * Días de retención. Stripe no deja cambiarlos por API «once an account has
   * been activated»: solo se mandan si difieren de los actuales.
   */
  readonly delayDays?: number;
}

export interface ConnectedAccountsApi {
  readonly flavor: AccountsApiFlavor;
  create(input: CreateConnectedAccountInput): Promise<CreatedConnectedAccount>;
  retrieve(stripeAccountId: string): Promise<StripeConnectedAccount>;
  createOnboardingLink(
    stripeAccountId: string,
    urls: { readonly refreshUrl: string; readonly returnUrl: string },
  ): Promise<{ readonly url: string; readonly expiresAt: Date | null }>;
  createLoginLink(stripeAccountId: string): Promise<{ readonly url: string }>;
  getBalanceSettings(stripeAccountId: string): Promise<StripeBalanceSettings>;
  updateBalanceSettings(
    stripeAccountId: string,
    input: UpdateBalanceSettingsInput,
  ): Promise<StripeBalanceSettings>;
}

const ACCOUNT_ID = /^acct_[A-Za-z0-9]{6,64}$/;

/** Lanza si no es un `acct_…`: nunca se interpola otra cosa en una ruta. */
export function assertStripeAccountId(value: string): string {
  if (!ACCOUNT_ID.test(value)) {
    throw new PlatformStripeApiError('identificador de cuenta conectada no válido', {
      status: 0,
      operation: 'validar acct_',
    });
  }
  return value;
}

/**
 * Descriptor de extracto a partir del nombre del aula. Reglas de Stripe:
 * 5–22 caracteres latinos, al menos una letra, sin `< > \ ' " *`. Se quitan
 * los acentos (ÁÉÍÓÚÑ → AEIOUN), se pasa a mayúsculas y se recorta. Si no
 * queda nada usable, `null`: mejor que lo pida el alta que mandar basura.
 */
export function sanitizeStatementDescriptor(name: string | null | undefined): string | null {
  if (!name) return null;
  const ascii = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .,\-&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = ascii.slice(0, 22).trim();
  if (cut.length < 5 || !/[A-Z]/.test(cut)) return null;
  return cut;
}

/**
 * Divisa de liquidación por defecto de un país admitido. Lo que no está aquí
 * se deja a Stripe (no se manda `currency`).
 */
const CURRENCY_BY_COUNTRY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      'AT',
      'BE',
      'BG',
      'HR',
      'CY',
      'EE',
      'FI',
      'FR',
      'DE',
      'GR',
      'IE',
      'IT',
      'LV',
      'LT',
      'LU',
      'MT',
      'NL',
      'PT',
      'SK',
      'SI',
      'ES',
    ].map((country) => [country, 'eur']),
  ),
  DK: 'dkk',
  SE: 'sek',
  NO: 'nok',
  PL: 'pln',
  CZ: 'czk',
  HU: 'huf',
  RO: 'ron',
  LI: 'chf',
  CH: 'chf',
  GB: 'gbp',
  US: 'usd',
  CA: 'cad',
};

export function defaultCurrencyForCountry(country: string): string | null {
  return CURRENCY_BY_COUNTRY[country.toUpperCase()] ?? null;
}

/**
 * ¿Es este error de Stripe un «no se puede tener una cuenta en ese país»?
 * Stripe solo lo distingue por el TEXTO; los literales salen del sandbox
 * (`tests/fixtures/sandbox-2026-11-12.json`, `countryErrors`).
 */
const COUNTRY_REJECTION_PATTERNS: readonly RegExp[] = [
  /cannot be created by platforms in [A-Z]{2}/i,
  /is not currently supported by Stripe/i,
  /is not available in country [A-Z]{2}/i,
  /recipient ToS agreement is not supported for platforms in [A-Z]{2} creating accounts in/i,
  /Funds can't be sent to accounts located in [A-Z]{2}/i,
  /restricted outside of your platform's region/i,
];

export function isCountryRejection(error: unknown): boolean {
  if (!(error instanceof PlatformStripeApiError) || !error.detail) return false;
  if (error.status < 400 || error.status >= 500) return false;
  return COUNTRY_REJECTION_PATTERNS.some((pattern) => pattern.test(error.detail!));
}

/** Traduce un rechazo por país al 422 del dominio; cualquier otra cosa se relanza tal cual. */
export function translateCountryRejection(error: unknown, country: string): never {
  if (isCountryRejection(error)) throw new PayoutsCountryUnsupportedError(country);
  throw error;
}

function v2CreateBody(input: CreateConnectedAccountInput): StripeParams {
  const profile: Record<string, unknown> = {};
  if (input.businessUrl) profile['business_url'] = input.businessUrl;
  if (input.productDescription) profile['product_description'] = input.productDescription;
  const merchant: Record<string, unknown> = {
    mcc: EDUCATION_MCC,
    capabilities: { card_payments: { requested: true } },
  };
  if (input.statementDescriptor) {
    merchant['statement_descriptor'] = { descriptor: input.statementDescriptor };
  }
  return {
    contact_email: input.email,
    display_name: input.displayName,
    dashboard: 'express',
    identity: { country: input.country.toLowerCase(), entity_type: input.entityType },
    configuration: {
      merchant,
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
    },
    defaults: {
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.locale ? { locales: [input.locale] } : {}),
      ...(Object.keys(profile).length > 0 ? { profile } : {}),
      responsibilities: {
        fees_collector: 'application',
        losses_collector: input.lossesCollector,
      },
    },
    metadata: { ...input.metadata },
  };
}

function v1CreateBody(input: CreateConnectedAccountInput): StripeParams {
  const businessProfile: Record<string, unknown> = {
    mcc: EDUCATION_MCC,
    name: input.displayName,
  };
  if (input.businessUrl) businessProfile['url'] = input.businessUrl;
  if (input.productDescription) businessProfile['product_description'] = input.productDescription;
  return {
    country: input.country,
    email: input.email,
    business_type: input.entityType,
    business_profile: businessProfile,
    ...(input.currency ? { default_currency: input.currency } : {}),
    ...(input.statementDescriptor
      ? { settings: { payments: { statement_descriptor: input.statementDescriptor } } }
      : {}),
    controller: {
      stripe_dashboard: { type: 'express' },
      fees: { payer: 'application' },
      losses: { payments: input.lossesCollector },
      requirement_collection: 'stripe',
    },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { ...input.metadata },
  };
}

/** Quita `business_url` y repite: el dominio del aula puede no resolver aún. */
function isInvalidBusinessUrl(error: unknown): boolean {
  return (
    error instanceof PlatformStripeApiError &&
    (error.stripeCode === 'url_invalid' ||
      (error.param ?? '').endsWith('business_url') ||
      (error.param ?? '').endsWith('business_profile[url]'))
  );
}

class StripeConnectedAccountsApi implements ConnectedAccountsApi {
  constructor(
    private readonly client: PlatformStripeClient,
    readonly flavor: AccountsApiFlavor,
  ) {}

  async create(input: CreateConnectedAccountInput): Promise<CreatedConnectedAccount> {
    try {
      return await this.createOnce(input);
    } catch (err) {
      if (input.businessUrl && isInvalidBusinessUrl(err)) {
        // Clave distinta: con la misma, Stripe respondería «idempotency_error»
        // por cambiar los parámetros.
        return this.createOnce({
          ...input,
          businessUrl: null,
          idempotencyKey: `${input.idempotencyKey}:sin-url`,
        });
      }
      throw err;
    }
  }

  private async createOnce(input: CreateConnectedAccountInput): Promise<CreatedConnectedAccount> {
    if (this.flavor === 'v2') {
      const created = await this.client.v2<{ id?: unknown; livemode?: unknown }>(
        'POST',
        '/v2/core/accounts',
        v2CreateBody(input),
        { idempotencyKey: input.idempotencyKey },
      );
      return {
        id: assertStripeAccountId(String(created.id)),
        livemode: created.livemode === true,
      };
    }
    const created = await this.client.v1<{ id?: unknown }>(
      'POST',
      '/v1/accounts',
      v1CreateBody(input),
      // Ver la cabecera del fichero: con la versión estable, Express exige
      // que la plataforma asuma las pérdidas.
      { idempotencyKey: input.idempotencyKey, apiVersion: PLATFORM_STRIPE_V2_API_VERSION },
    );
    return { id: assertStripeAccountId(String(created.id)), livemode: this.client.livemode };
  }

  retrieve(stripeAccountId: string): Promise<StripeConnectedAccount> {
    return this.client.v1<StripeConnectedAccount>(
      'GET',
      `/v1/accounts/${assertStripeAccountId(stripeAccountId)}`,
    );
  }

  async createOnboardingLink(
    stripeAccountId: string,
    urls: { readonly refreshUrl: string; readonly returnUrl: string },
  ): Promise<{ url: string; expiresAt: Date | null }> {
    const link = await this.client.v1<{ url?: unknown; expires_at?: unknown }>(
      'POST',
      '/v1/account_links',
      {
        account: assertStripeAccountId(stripeAccountId),
        type: 'account_onboarding',
        refresh_url: urls.refreshUrl,
        return_url: urls.returnUrl,
        collection_options: { fields: 'eventually_due' },
      },
    );
    if (typeof link.url !== 'string') {
      throw new PlatformStripeApiError('respuesta sin url', {
        status: 200,
        operation: 'POST /v1/account_links',
      });
    }
    return {
      url: link.url,
      expiresAt: typeof link.expires_at === 'number' ? new Date(link.expires_at * 1000) : null,
    };
  }

  async createLoginLink(stripeAccountId: string): Promise<{ url: string }> {
    const link = await this.client.v1<{ url?: unknown }>(
      'POST',
      `/v1/accounts/${assertStripeAccountId(stripeAccountId)}/login_links`,
    );
    if (typeof link.url !== 'string') {
      throw new PlatformStripeApiError('respuesta sin url', {
        status: 200,
        operation: 'POST /v1/accounts/:id/login_links',
      });
    }
    return { url: link.url };
  }

  getBalanceSettings(stripeAccountId: string): Promise<StripeBalanceSettings> {
    return this.client.v1<StripeBalanceSettings>('GET', '/v1/balance_settings', undefined, {
      account: assertStripeAccountId(stripeAccountId),
    });
  }

  updateBalanceSettings(
    stripeAccountId: string,
    input: UpdateBalanceSettingsInput,
  ): Promise<StripeBalanceSettings> {
    const schedule: Record<string, unknown> = { interval: input.interval };
    if (input.interval === 'weekly' && input.weeklyDay) {
      schedule['weekly_payout_days'] = [input.weeklyDay];
    }
    if (input.interval === 'monthly' && input.monthlyDay) {
      schedule['monthly_payout_days'] = [input.monthlyDay];
    }
    const payouts: Record<string, unknown> = { schedule };
    if (input.minimumBalanceByCurrency && Object.keys(input.minimumBalanceByCurrency).length > 0) {
      payouts['minimum_balance_by_currency'] = { ...input.minimumBalanceByCurrency };
    }
    const payments: Record<string, unknown> = { payouts };
    if (input.delayDays !== undefined) {
      payments['settlement_timing'] = { delay_days_override: input.delayDays };
    }
    return this.client.v1<StripeBalanceSettings>(
      'POST',
      '/v1/balance_settings',
      { payments },
      { account: assertStripeAccountId(stripeAccountId) },
    );
  }
}

export function createConnectedAccountsApi(
  client: PlatformStripeClient,
  flavor: AccountsApiFlavor,
): ConnectedAccountsApi {
  return new StripeConnectedAccountsApi(client, flavor);
}
