/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsAccountStatus, Prisma, PrismaClient } from '@didacta/database';
import {
  PayoutsAccountAlreadyStartedError,
  PayoutsAccountNotFoundError,
  PayoutsAccountOnboardingIncompleteError,
  PayoutsCountryUnsupportedError,
  PayoutsInvalidEntityTypeError,
  PlatformStripeApiError,
} from './errors.js';
import { RefsService } from './refs.service.js';
import {
  ACCOUNT_ENTITY_TYPES,
  defaultCurrencyForCountry,
  isCountryRejection,
  sanitizeStatementDescriptor,
  type AccountEntityType,
  type ConnectedAccountsApi,
  type StripeBalanceSettings,
  type StripeConnectedAccount,
  type StripePayoutScheduleV1,
} from './stripe/accounts-api.js';

/**
 * Alta del creador y estado de su cuenta conectada (`mod_payouts_account`).
 *
 * Reglas que no son negociables:
 *
 *  1. **El estado sale SIEMPRE de Stripe.** `syncAccount` lee la cuenta con
 *     `GET /v1/accounts/{id}` y la pasa por `deriveStatus`. Ni la vuelta del
 *     alta, ni un webhook, ni el conciliador fijan el estado con lo que traen:
 *     solo DISPARAN la lectura. Un evento forjado, como mucho, provoca una
 *     consulta de más.
 *  2. **País fuera de la lista → 422 sin llamar a Stripe.** Y si Stripe
 *     rechaza un país que sí estaba (sus textos de `countryErrors`), el mismo
 *     422: para el creador es lo mismo.
 *  3. **Una cuenta viva por tenant.** Dos «Conectar» seguidos (o a la vez)
 *     acaban en UNA cuenta de Stripe. Ver `startOnboarding`.
 *  4. **`ready_at` se sella la primera vez que la cuenta llega a READY** y no
 *     se borra nunca: el resolver de modo de cobro lo usa para saber si el
 *     tenant ha operado alguna vez en modo plataforma.
 *
 * Acceso a datos: todo pasa por `PayoutsDbPort`, que en el host abre una
 * transacción con el GUC del tenant (RLS) o, para los barridos del worker,
 * acceso global sancionado. Ninguna llamada a Stripe ocurre con una
 * transacción abierta.
 */

export type PayoutsTx = Prisma.TransactionClient;

export interface PayoutsDbPort {
  /** Transacción escopada al tenant (RLS con `app.current_tenant_id`). */
  inTenant<T>(tenantId: string, fn: (tx: PayoutsTx) => Promise<T>): Promise<T>;
  /** Acceso global sancionado: solo barridos de infraestructura. */
  global<T>(fn: (tx: PayoutsTx) => Promise<T>): Promise<T>;
}

export type PayoutsPayoutInterval = 'daily' | 'weekly' | 'monthly' | 'manual';

export interface PayoutsAccountsConfig {
  /** ISO 3166-1 alfa-2, mayúsculas. */
  readonly supportedCountries: readonly string[];
  readonly lossesCollector: 'stripe' | 'application';
  /** `true` si la clave de plataforma es de producción. */
  readonly livemode: boolean;
  readonly payout: {
    readonly interval: PayoutsPayoutInterval;
    readonly weeklyDay: string;
    readonly delayDays: number;
    readonly minBalance: Readonly<Record<string, number>>;
  };
}

/** Lo que el host sabe del aula y de quien conecta (el módulo no lee tablas del core). */
export interface OnboardingPrefill {
  readonly email: string;
  readonly displayName: string;
  /** Dominio público del aula, sin esquema. `null` en local o sin dominio. */
  readonly hostname?: string | null;
  /** `es`, `en`… del aula, para el idioma del alta alojada. */
  readonly locale?: string | null;
}

export interface OnboardingUrls {
  /** Adónde vuelve Stripe al terminar (o al salir) del alta. */
  readonly returnUrl: string;
  /** Adónde manda Stripe si el enlace caducó: allí se pide uno nuevo. */
  readonly refreshUrl: string;
}

/** Categoría del primer dato que falta, para el texto «Falta un dato: {requisito}». */
export type PayoutsRequirementCategory =
  | 'bank_account'
  | 'identity_document'
  | 'personal_details'
  | 'business_details'
  | 'terms'
  | 'other';

export interface PayoutScheduleView {
  readonly interval: string;
  /** `monday`… con `weekly`. */
  readonly weeklyDay: string | null;
  /** 1–31 con `monthly`. */
  readonly monthlyDay: number | null;
  readonly delayDays: number | null;
  /** Colchón por divisa (minúsculas → unidad mínima). */
  readonly minimumBalance: Readonly<Record<string, number>> | null;
}

/** Lo que ve el creador (y el plano de control) de su cuenta. Sin datos personales. */
export interface PayoutsAccountView {
  readonly status: PayoutsAccountStatus;
  readonly stripeAccountId: string | null;
  readonly country: string;
  readonly entityType: string;
  readonly defaultCurrency: string | null;
  readonly cardPaymentsStatus: string | null;
  readonly transfersStatus: string | null;
  readonly payoutsEnabled: boolean;
  /** Primer dato pendiente, o `null` si no falta nada. */
  readonly pendingRequirement: PayoutsRequirementCategory | null;
  readonly requirementsDeadline: string | null;
  readonly disabledReason: string | null;
  readonly payoutSchedule: PayoutScheduleView | null;
  readonly livemode: boolean;
  readonly readyAt: string | null;
  readonly lastSyncedAt: string | null;
}

export interface DerivedAccountStatus {
  readonly status: Exclude<PayoutsAccountStatus, 'NOT_CONNECTED' | 'DISCONNECTED'>;
  readonly cardPaymentsStatus: string | null;
  readonly transfersStatus: string | null;
  readonly currentlyDue: string[];
  readonly pastDue: string[];
  readonly pendingRequirement: PayoutsRequirementCategory | null;
  readonly disabledReason: string | null;
}

/** Motivo propio (no de Stripe) cuando el país dejó de estar admitido. */
export const COUNTRY_NOT_SUPPORTED_REASON = 'platform.country_unsupported';

const PENDING_REVIEW_REASONS = new Set([
  'requirements.pending_verification',
  'under_review',
  'pending.onboarding',
  'pending.review',
]);

function asList(value: readonly string[] | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * Categoría de un requisito de Stripe (`external_account`,
 * `individual.verification.document`, `business_profile.url`…).
 */
export function requirementCategory(requirement: string): PayoutsRequirementCategory {
  if (requirement === 'external_account' || requirement.startsWith('external_account'))
    return 'bank_account';
  if (/(^|\.)verification\.(additional_)?document/.test(requirement)) return 'identity_document';
  if (requirement.startsWith('tos_acceptance')) return 'terms';
  if (
    requirement.startsWith('business_profile') ||
    requirement.startsWith('company') ||
    requirement.startsWith('settings')
  ) {
    return 'business_details';
  }
  if (
    requirement.startsWith('individual') ||
    requirement.startsWith('representative') ||
    /^person_/.test(requirement) ||
    /^(owners|directors|executives)/.test(requirement)
  ) {
    return 'personal_details';
  }
  return 'other';
}

/**
 * Estado de la cuenta a partir de la vista v1 de Stripe. Tabla del plan:
 *
 * | Situación en Stripe                                     | Estado         |
 * |---------------------------------------------------------|----------------|
 * | `disabled_reason` de rechazo (`rejected.*`)             | REJECTED       |
 * | `card_payments` y `transfers` activos, nada vencido     | READY          |
 * | Datos sin enviar (`details_submitted: false`)           | ONBOARDING     |
 * | `past_due`, o capacidad desactivada por otro motivo     | RESTRICTED     |
 * | Enviado y capacidades pendientes / en verificación      | PENDING_REVIEW |
 * | Enviado y Stripe pide algo más (aún no vencido)         | ONBOARDING     |
 *
 * Además: una cuenta de un país que ya no está en la lista de admitidos es
 * RESTRICTED aunque Stripe la tenga activa (México: Stripe deja crearla y
 * activarla, pero «Funds can't be sent to accounts located in MX»).
 *
 * Una cuenta recién creada trae TODOS sus requisitos como `past_due` y sus
 * capacidades `inactive` (es así en el sandbox): eso es ONBOARDING, no
 * RESTRICTED, y por eso `details_submitted` se mira antes que `past_due`.
 */
export function deriveStatus(
  account: StripeConnectedAccount,
  options: { readonly supportedCountries: readonly string[] },
): DerivedAccountStatus {
  const caps = account.capabilities ?? {};
  const card = typeof caps['card_payments'] === 'string' ? caps['card_payments'] : null;
  const transfers = typeof caps['transfers'] === 'string' ? caps['transfers'] : null;
  const requirements = account.requirements ?? {};
  const currentlyDue = asList(requirements.currently_due);
  const pastDue = asList(requirements.past_due);
  const eventuallyDue = asList(requirements.eventually_due);
  const pendingVerification = asList(requirements.pending_verification);
  const stripeReason = requirements.disabled_reason ?? null;
  const firstMissing = pastDue[0] ?? currentlyDue[0] ?? eventuallyDue[0] ?? null;
  const base = {
    cardPaymentsStatus: card,
    transfersStatus: transfers,
    currentlyDue,
    pastDue,
    disabledReason: stripeReason,
  };
  const withRequirement = (status: DerivedAccountStatus['status']): DerivedAccountStatus => ({
    ...base,
    status,
    pendingRequirement:
      status === 'READY' || status === 'PENDING_REVIEW' || status === 'REJECTED'
        ? null
        : firstMissing
          ? requirementCategory(firstMissing)
          : null,
  });

  if (stripeReason && stripeReason.startsWith('rejected')) return withRequirement('REJECTED');

  const country = (account.country ?? '').toUpperCase();
  if (country && !options.supportedCountries.includes(country)) {
    return {
      ...base,
      status: 'RESTRICTED',
      pendingRequirement: null,
      disabledReason: COUNTRY_NOT_SUPPORTED_REASON,
    };
  }

  if (card === 'active' && transfers === 'active' && pastDue.length === 0) {
    return withRequirement('READY');
  }
  if (account.details_submitted !== true) return withRequirement('ONBOARDING');
  if (pastDue.length > 0) return withRequirement('RESTRICTED');
  if (
    card === 'pending' ||
    transfers === 'pending' ||
    pendingVerification.length > 0 ||
    (stripeReason !== null && PENDING_REVIEW_REASONS.has(stripeReason))
  ) {
    return withRequirement('PENDING_REVIEW');
  }
  if (currentlyDue.length > 0) return withRequirement('ONBOARDING');
  if (card === 'inactive' || transfers === 'inactive' || stripeReason) {
    return withRequirement('RESTRICTED');
  }
  return withRequirement('PENDING_REVIEW');
}

/** Calendario en la forma del espejo (`payout_schedule`). */
export function scheduleFromAccount(
  schedule: StripePayoutScheduleV1 | null | undefined,
  minimumBalance: Readonly<Record<string, number>> | null,
): PayoutScheduleView | null {
  if (!schedule?.interval) return null;
  const weekly = schedule.weekly_payout_days?.[0] ?? schedule.weekly_anchor ?? null;
  return {
    interval: schedule.interval,
    weeklyDay: schedule.interval === 'weekly' ? weekly : null,
    monthlyDay: schedule.interval === 'monthly' ? (schedule.monthly_anchor ?? null) : null,
    delayDays: typeof schedule.delay_days === 'number' ? schedule.delay_days : null,
    minimumBalance,
  };
}

function scheduleFromBalanceSettings(settings: StripeBalanceSettings): PayoutScheduleView | null {
  const payouts = settings.payments?.payouts;
  const schedule = payouts?.schedule;
  if (!schedule?.interval) return null;
  return {
    interval: schedule.interval,
    weeklyDay: schedule.interval === 'weekly' ? (schedule.weekly_payout_days?.[0] ?? null) : null,
    monthlyDay:
      schedule.interval === 'monthly' ? (schedule.monthly_payout_days?.[0] ?? null) : null,
    delayDays: settings.payments?.settlement_timing?.delay_days ?? null,
    minimumBalance: payouts?.minimum_balance_by_currency
      ? { ...payouts.minimum_balance_by_currency }
      : null,
  };
}

/** Dominio que se puede enseñar a Stripe como web del negocio. */
export function publicBusinessUrl(hostname: string | null | undefined): string | null {
  if (!hostname) return null;
  const host = hostname.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null; // localhost, IP, sin TLD
  if (/(^|\.)(localhost|local|test|example|invalid|internal)$/.test(host)) return null;
  return `https://${host}`;
}

const LOCALE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  es: 'es-ES',
  en: 'en-US',
  pt: 'pt-BR',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
};

function onboardingLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const language = locale.toLowerCase().split(/[-_]/)[0] ?? '';
  return LOCALE_BY_LANGUAGE[language] ?? null;
}

type AccountRow = Awaited<ReturnType<PayoutsTx['modPayoutsAccount']['findFirstOrThrow']>>;

function toView(row: AccountRow): PayoutsAccountView {
  const due = Array.isArray(row.requirementsPastDue) ? (row.requirementsPastDue as string[]) : [];
  const current = Array.isArray(row.requirementsCurrentlyDue)
    ? (row.requirementsCurrentlyDue as string[])
    : [];
  const first = due[0] ?? current[0] ?? null;
  const showRequirement =
    row.status === 'ONBOARDING' || row.status === 'RESTRICTED' || row.status === 'NOT_CONNECTED';
  return {
    status: row.status,
    stripeAccountId: row.stripeAccountId,
    country: row.country,
    entityType: row.entityType,
    defaultCurrency: row.defaultCurrency,
    cardPaymentsStatus: row.cardPaymentsStatus,
    transfersStatus: row.transfersStatus,
    payoutsEnabled: row.payoutsEnabled,
    pendingRequirement: pendingRequirementOf(
      row.status,
      row.disabledReason,
      first,
      showRequirement,
    ),
    requirementsDeadline: row.requirementsDeadline?.toISOString() ?? null,
    disabledReason: row.disabledReason,
    payoutSchedule: (row.payoutSchedule as PayoutScheduleView | null) ?? null,
    livemode: row.livemode,
    readyAt: row.readyAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}

function pendingRequirementOf(
  status: PayoutsAccountStatus,
  disabledReason: string | null,
  first: string | null,
  showRequirement: boolean,
): PayoutsRequirementCategory | null {
  if (showRequirement && first) return requirementCategory(first);
  // Restringida sin un dato concreto que pedir (y no por país): «Completar»
  // lleva igualmente al alta de Stripe, que dirá qué falta.
  if (status === 'RESTRICTED' && disabledReason !== COUNTRY_NOT_SUPPORTED_REASON) return 'other';
  return null;
}

/** Logger mínimo (el host pasa el suyo). */
export interface PayoutsLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  log?(obj: Record<string, unknown>, msg: string): void;
  /** Alertas (`{ alert: 'payouts.…' }`). Sin él, van a `warn`. */
  error?(obj: Record<string, unknown>, msg: string): void;
}

const SILENT_LOGGER: PayoutsLogger = { warn: () => undefined };

export interface PayoutsAccountsServiceOptions {
  readonly now?: () => Date;
  readonly logger?: PayoutsLogger;
  /** Espera entre reintentos de un alta concurrente (tests: 0). */
  readonly retryDelayMs?: number;
}

/** Cuenta a sincronizar en un barrido del worker. */
export interface AccountToSync {
  readonly tenantId: string;
  readonly stripeAccountId: string;
  readonly status: PayoutsAccountStatus;
  readonly hasSchedule: boolean;
}

export class PayoutsAccountsService {
  private readonly now: () => Date;
  private readonly logger: PayoutsLogger;
  private readonly retryDelayMs: number;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly api: ConnectedAccountsApi,
    private readonly config: PayoutsAccountsConfig,
    options: PayoutsAccountsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? SILENT_LOGGER;
    this.retryDelayMs = options.retryDelayMs ?? 750;
  }

  /** ¿Se puede pagar a creadores de este país? */
  isCountrySupported(country: string): boolean {
    return this.config.supportedCountries.includes(country.toUpperCase());
  }

  get supportedCountries(): readonly string[] {
    return this.config.supportedCountries;
  }

  /** Cuenta viva del tenant (la más reciente sin cerrar), o `null`. */
  async getAccount(tenantId: string): Promise<PayoutsAccountView | null> {
    const row = await this.db.inTenant(tenantId, (tx) => findLiveAccount(tx, tenantId));
    return row ? toView(row) : null;
  }

  /**
   * «Conectar cobros». Devuelve la cuenta y el enlace del alta alojada.
   *
   * Una cuenta viva por tenant, sin índice parcial (Prisma 5 no lo declara y
   * los entornos que aplican el esquema con `db push` lo borrarían en
   * silencio). En su lugar:
   *
   *  1. Bajo `pg_advisory_xact_lock` del tenant se busca la cuenta viva y, si
   *     no hay, se inserta una fila SIN `acct_` todavía. Dos peticiones a la
   *     vez se serializan aquí y acaban viendo LA MISMA fila.
   *  2. La cuenta de Stripe se crea con `Idempotency-Key =
   *     payouts:account:<id de la fila>`: si las dos llegan a Stripe, Stripe
   *     devuelve la misma cuenta a las dos (y si una choca con la otra en
   *     vuelo, 409, se reintenta).
   *  3. El `acct_` se escribe solo si la fila aún no tenía uno, y la columna
   *     es única: nunca quedan dos filas apuntando a cuentas distintas.
   */
  async startOnboarding(input: {
    readonly tenantId: string;
    readonly country: string;
    readonly entityType: string;
    readonly prefill: OnboardingPrefill;
    readonly urls: OnboardingUrls;
  }): Promise<{ account: PayoutsAccountView; onboardingUrl: string | null }> {
    const country = input.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !this.isCountrySupported(country)) {
      // Sin tocar Stripe NI la base.
      throw new PayoutsCountryUnsupportedError(country.slice(0, 2) || '??');
    }
    if (!(ACCOUNT_ENTITY_TYPES as readonly string[]).includes(input.entityType)) {
      throw new PayoutsInvalidEntityTypeError(input.entityType);
    }
    const entityType = input.entityType as AccountEntityType;

    // 1. Fila viva única bajo cerrojo.
    const row = await this.db.inTenant(input.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payouts:connect:${input.tenantId}`}::text, 0))`;
      const live = await findLiveAccount(tx, input.tenantId);
      if (live) {
        const sameChoice = live.country === country && live.entityType === entityType;
        // Reconexión tras «Desconectar»: la misma cuenta de Stripe vuelve a
        // operar; su estado real lo fija `syncAccount` a continuación.
        if (live.status === 'DISCONNECTED' && live.stripeAccountId !== null) {
          return tx.modPayoutsAccount.update({
            where: { id: live.id },
            data: { status: 'ONBOARDING' },
          });
        }
        if (sameChoice) return live;
        if (live.stripeAccountId !== null) {
          throw new PayoutsAccountAlreadyStartedError(live.country);
        }
        // Fila sin cuenta en Stripe (un intento anterior que no llegó a
        // crearla): se corrige la elección, no se crea otra fila.
        return tx.modPayoutsAccount.update({
          where: { id: live.id },
          data: { country, entityType },
        });
      }
      return tx.modPayoutsAccount.create({
        data: {
          tenantId: input.tenantId,
          country,
          entityType,
          status: 'NOT_CONNECTED',
          livemode: this.config.livemode,
        },
      });
    });

    // 2. Cuenta en Stripe (idempotente por fila).
    let current = row;
    if (current.stripeAccountId === null) {
      const created = await this.createInStripe(
        current.id,
        input.tenantId,
        country,
        entityType,
        input.prefill,
      );
      current = await this.db.inTenant(input.tenantId, async (tx) => {
        await new RefsService(tx as unknown as PrismaClient).register({
          tenantId: input.tenantId,
          stripeObjectId: created.id,
          kind: 'account',
          source: 'payouts',
          localRef: current.id,
          livemode: created.livemode,
        });
        await tx.modPayoutsAccount.updateMany({
          where: { id: current.id, stripeAccountId: null },
          data: { stripeAccountId: created.id, status: 'ONBOARDING', livemode: created.livemode },
        });
        return tx.modPayoutsAccount.findUniqueOrThrow({ where: { id: current.id } });
      });
    }

    // 3. Estado real; `syncAccount` aplica antes el calendario si falta.
    const account = await this.syncAccount(input.tenantId);

    // 4. Enlace del alta (salvo que ya esté lista).
    if (account.status === 'READY') return { account, onboardingUrl: null };
    const link = await this.api.createOnboardingLink(account.stripeAccountId!, input.urls);
    return { account, onboardingUrl: link.url };
  }

  /** Enlace nuevo del alta alojada («Completar», o el enlace anterior caducó). */
  async refreshLink(tenantId: string, urls: OnboardingUrls): Promise<{ url: string }> {
    const row = await this.db.inTenant(tenantId, (tx) => findLiveAccount(tx, tenantId));
    if (!row?.stripeAccountId) throw new PayoutsAccountNotFoundError();
    const link = await this.api.createOnboardingLink(row.stripeAccountId, urls);
    return { url: link.url };
  }

  /** Enlace al panel Express del creador («Ver mis pagos en Stripe»). */
  async dashboardLink(tenantId: string): Promise<{ url: string }> {
    const row = await this.db.inTenant(tenantId, (tx) => findLiveAccount(tx, tenantId));
    if (!row?.stripeAccountId) throw new PayoutsAccountNotFoundError();
    try {
      return await this.api.createLoginLink(row.stripeAccountId);
    } catch (err) {
      if (
        err instanceof PlatformStripeApiError &&
        err.status === 400 &&
        /not completed onboarding/i.test(err.detail ?? '')
      ) {
        throw new PayoutsAccountOnboardingIncompleteError();
      }
      throw err;
    }
  }

  /**
   * Consulta la cuenta en Stripe y reescribe el espejo. Es lo ÚNICO que
   * cambia el estado de una cuenta. Sin cuenta viva con `acct_`, no hace nada
   * y devuelve lo que haya (o lanza si no hay ni fila).
   *
   * `expectedAccountId`: si quien llama viene de un evento, el `acct_` del
   * evento. Si ya no es la cuenta viva del tenant (otra más nueva, o cerrada)
   * no se toca nada.
   */
  async syncAccount(tenantId: string, expectedAccountId?: string): Promise<PayoutsAccountView> {
    let row = await this.db.inTenant(tenantId, (tx) => findLiveAccount(tx, tenantId));
    if (!row) throw new PayoutsAccountNotFoundError();
    if (!row.stripeAccountId) return toView(row);
    if (expectedAccountId && expectedAccountId !== row.stripeAccountId) return toView(row);
    const stripeAccountId = row.stripeAccountId;

    // Calendario pendiente (falló al crear la cuenta): se reintenta en cada
    // sincronización. Sin Redis no hay worker, y esto lo recogen la vuelta del
    // alta y los eventos de cuenta. Un fallo aquí no impide leer el estado.
    if (row.payoutSchedule === null) {
      const applied = await this.applyPayoutSchedule(tenantId).catch((err: unknown) => {
        this.logger.warn(
          { tenantId, err: describeError(err) },
          'mod.payouts: el calendario de pagos sigue sin poder aplicarse',
        );
        return null;
      });
      if (applied) {
        row = (await this.db.inTenant(tenantId, (tx) => findLiveAccount(tx, tenantId))) ?? row;
      }
    }

    const remote = await this.api.retrieve(stripeAccountId);
    const derived = deriveStatus(remote, { supportedCountries: this.config.supportedCountries });
    const now = this.now();
    const minimumBalance =
      (row.payoutSchedule as PayoutScheduleView | null)?.minimumBalance ?? null;
    const schedule =
      scheduleFromAccount(remote.settings?.payouts?.schedule, minimumBalance) ??
      (row.payoutSchedule as PayoutScheduleView | null);
    const deadline = remote.requirements?.current_deadline;

    const updated = await this.db.inTenant(tenantId, async (tx) => {
      // «Desconectada» la decide el creador (o la baja del aula), no Stripe:
      // se refresca el espejo pero el estado se queda.
      const current = await tx.modPayoutsAccount.findUniqueOrThrow({
        where: { id: row.id },
        select: { status: true },
      });
      const disconnected = current.status === 'DISCONNECTED';
      await tx.modPayoutsAccount.update({
        where: { id: row.id },
        data: {
          status: disconnected ? 'DISCONNECTED' : derived.status,
          country: (remote.country ?? row.country).toUpperCase(),
          cardPaymentsStatus: derived.cardPaymentsStatus,
          transfersStatus: derived.transfersStatus,
          payoutsEnabled: remote.payouts_enabled === true,
          requirementsCurrentlyDue: derived.currentlyDue,
          requirementsPastDue: derived.pastDue,
          requirementsDeadline: typeof deadline === 'number' ? new Date(deadline * 1000) : null,
          disabledReason: derived.disabledReason,
          defaultCurrency: remote.default_currency ?? row.defaultCurrency,
          feesCollector: remote.controller?.fees?.payer ?? row.feesCollector,
          lossesCollector: remote.controller?.losses?.payments ?? row.lossesCollector,
          ...(row.payoutSchedule !== null && schedule
            ? { payoutSchedule: schedule as unknown as Prisma.InputJsonValue }
            : {}),
          lastSyncedAt: now,
        },
      });
      if (derived.status === 'READY' && !disconnected) {
        // Sello de «ha operado»: la primera vez, y nunca se borra.
        await tx.modPayoutsAccount.updateMany({
          where: { id: row.id, readyAt: null },
          data: { readyAt: now },
        });
      }
      return tx.modPayoutsAccount.findUniqueOrThrow({ where: { id: row.id } });
    });
    return toView(updated);
  }

  /**
   * «Desconectar cobros» (o baja del aula): la cuenta deja de poder vender
   * (`DISCONNECTED` → el resolutor de modo de cobro cierra el checkout) pero
   * la cuenta de Stripe NO se cierra: hacen falta 120 días para poder
   * revertir disputas, y lo pendiente de transferir se sigue transfiriendo.
   * Idempotente. Sin cuenta viva, no hace nada.
   */
  async disconnect(
    tenantId: string,
  ): Promise<{ account: PayoutsAccountView | null; changed: boolean }> {
    return this.db.inTenant(tenantId, async (tx) => {
      const live = await findLiveAccount(tx, tenantId);
      if (!live) return { account: null, changed: false };
      if (live.status === 'DISCONNECTED') return { account: toView(live), changed: false };
      const updated = await tx.modPayoutsAccount.update({
        where: { id: live.id },
        data: { status: 'DISCONNECTED' },
      });
      return { account: toView(updated), changed: true };
    });
  }

  /**
   * Fija el calendario de pagos de la cuenta (semanal, lunes, colchón por
   * divisa…) con `POST /v1/balance_settings` y lo deja en `payout_schedule`
   * tal como lo devuelve Stripe.
   *
   * Los días de retención solo se mandan si difieren de los que ya tiene la
   * cuenta: Stripe responde 400 a cualquier `delay_days` una vez activada
   * («You cannot change payments[settlement_timing][delay_days] via API once
   * an account has been activated»). Si aun así los rechaza, se aplica el
   * resto y se registra el aviso.
   */
  async applyPayoutSchedule(tenantId: string): Promise<PayoutScheduleView | null> {
    const row = await this.db.inTenant(tenantId, (tx) => findLiveAccount(tx, tenantId));
    if (!row?.stripeAccountId) throw new PayoutsAccountNotFoundError();
    const acct = row.stripeAccountId;
    const payout = this.config.payout;

    const current = await this.api.getBalanceSettings(acct);
    const currentDelay = current.payments?.settlement_timing?.delay_days ?? null;
    // Colchón SOLO en la divisa de la cuenta: Stripe rechaza el lote entero si
    // lleva una que la cuenta no maneja («Cannot set minimum balance for
    // currency gbp» en una cuenta española, visto en el sandbox).
    const currency = (row.defaultCurrency ?? defaultCurrencyForCountry(row.country))?.toLowerCase();
    const minimum =
      currency && payout.minBalance[currency] !== undefined
        ? { [currency]: payout.minBalance[currency]! }
        : undefined;
    const base = {
      interval: payout.interval,
      ...(payout.interval === 'weekly' ? { weeklyDay: payout.weeklyDay } : {}),
      ...(minimum ? { minimumBalanceByCurrency: minimum } : {}),
    } as const;

    let applied: StripeBalanceSettings;
    if (currentDelay !== null && currentDelay !== payout.delayDays) {
      try {
        applied = await this.api.updateBalanceSettings(acct, {
          ...base,
          delayDays: payout.delayDays,
        });
      } catch (err) {
        if (!(err instanceof PlatformStripeApiError) || err.status !== 400) throw err;
        this.logger.warn(
          { tenantId, stripeAccountId: acct, err: describeError(err) },
          'mod.payouts: Stripe no deja cambiar los días de retención; se aplica el resto del calendario',
        );
        applied = await this.api.updateBalanceSettings(acct, base);
      }
    } else {
      applied = await this.api.updateBalanceSettings(acct, base);
    }

    const schedule = scheduleFromBalanceSettings(applied);
    await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsAccount.update({
        where: { id: row.id },
        data: {
          payoutSchedule: (schedule ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        },
      }),
    );
    return schedule;
  }

  /**
   * Cuentas vivas a sincronizar en un barrido. `ready: false` → todas las que
   * no están READY ni cerradas; `ready: true` → las READY. Acceso global
   * sancionado: solo para el worker.
   */
  async listAccountsToSync(options: { readonly ready: boolean }): Promise<AccountToSync[]> {
    const rows = await this.db.global((tx) =>
      tx.modPayoutsAccount.findMany({
        where: {
          closedAt: null,
          stripeAccountId: { not: null },
          status: options.ready ? 'READY' : { notIn: ['READY', 'DISCONNECTED'] },
        },
        select: { tenantId: true, stripeAccountId: true, status: true, payoutSchedule: true },
        orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
      }),
    );
    return rows.map((row) => ({
      tenantId: row.tenantId,
      stripeAccountId: row.stripeAccountId!,
      status: row.status,
      hasSchedule: row.payoutSchedule !== null,
    }));
  }

  private async createInStripe(
    rowId: string,
    tenantId: string,
    country: string,
    entityType: AccountEntityType,
    prefill: OnboardingPrefill,
  ): Promise<{ id: string; livemode: boolean }> {
    const request = {
      country,
      entityType,
      email: prefill.email,
      displayName: prefill.displayName,
      businessUrl: publicBusinessUrl(prefill.hostname),
      productDescription: 'Cursos online y membresías',
      statementDescriptor: sanitizeStatementDescriptor(prefill.displayName),
      currency: defaultCurrencyForCountry(country),
      locale: onboardingLocale(prefill.locale),
      lossesCollector: this.config.lossesCollector,
      metadata: { didacta_tenant_id: tenantId, didacta_account_row_id: rowId },
      idempotencyKey: `payouts:account:${rowId}`,
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.api.create(request);
      } catch (err) {
        if (isCountryRejection(err)) {
          // La fila no llegó a tener cuenta: fuera, para poder elegir otro país.
          await this.db.inTenant(tenantId, (tx) =>
            tx.modPayoutsAccount.deleteMany({ where: { id: rowId, stripeAccountId: null } }),
          );
          throw new PayoutsCountryUnsupportedError(country);
        }
        // 409 de Stripe: la otra petición con la misma clave sigue en vuelo.
        const inFlight = err instanceof PlatformStripeApiError && err.status === 409;
        if (!inFlight || attempt >= 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
  }
}

function findLiveAccount(tx: PayoutsTx, tenantId: string) {
  return tx.modPayoutsAccount.findFirst({
    where: { tenantId, closedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

function describeError(err: unknown): string {
  if (err instanceof PlatformStripeApiError)
    return `${err.operation}: ${err.detail ?? err.message}`;
  return err instanceof Error ? err.message : String(err);
}
