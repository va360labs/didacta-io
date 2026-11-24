/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lógica pura del editor de NIVELES de la membresía (sin React): importes,
 * nombre por defecto de cada precio, orden de los niveles, lo que incluye cada
 * uno y la validación de los formularios. Se prueba sola en
 * `tier-helpers.test.ts`; la comparte la página completa de la membresía.
 */

import type { MembershipAdminPlan, MembershipAdminTier, PlanInput } from '@/lib/membership';
import { buildPrice, type CurrencyOptionDraft, type PriceDraftError } from '@/lib/pricing';
import { minorToInput, parseMajorInput } from '@/lib/stripe-currencies';

/**
 * Monedas del selector con claves propias (las de siempre de la membresía).
 * Con cobros de plataforma manda `usePricePolicy`.
 */
export const MEMBERSHIP_CURRENCY_OPTIONS: readonly string[] = [
  'eur',
  'usd',
  'gbp',
  'mxn',
  'cop',
  'ars',
  'pen',
  'brl',
];

/** Periodicidades habituales del selector; la API admite cualquier 1..12. */
export const INTERVAL_PRESETS: readonly number[] = [1, 3, 6, 12];

/** Límites de la API (`membership-tiers.dto.ts` y `membership.dto.ts`). */
export const TIER_NAME_MAX = 60;
export const TIER_DESCRIPTION_MAX = 400;
export const PLAN_NAME_MAX = 80;
export const TRIAL_DAYS_MAX = 365;

// ── Importes ────────────────────────────────────────────────────────────────

/**
 * Lo que escribe el admin («999», «999,5», «39.900») → unidad mínima de STRIPE
 * para esa moneda (`@/lib/stripe-currencies`: COP y HUF con dos decimales
 * aunque `Intl` diga cero; JPY sin ninguno). `0` vale (plan gratis de los de
 * antes). `null` si no es un importe.
 */
export function amountToMinor(raw: string, currency: string, locale: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^0+([.,]0+)?$/.test(t)) return 0;
  return parseMajorInput(t, currency, locale);
}

/** Unidad mínima → texto editable del campo (vacío si no hay importe). */
export function minorToAmount(minor: number | null, currency: string, locale: string): string {
  if (minor === null) return '';
  return minorToInput(minor, currency, locale);
}

/** Opciones del selector de periodicidad: las habituales y, si es otra, también la actual. */
export function intervalOptions(current: number): number[] {
  return INTERVAL_PRESETS.includes(current)
    ? [...INTERVAL_PRESETS]
    : [...INTERVAL_PRESETS, current].sort((a, b) => a - b);
}

// ── Nombre y valores por defecto de un precio ───────────────────────────────

/**
 * Nombre por defecto de un precio: «<nivel> · <periodicidad>» («Pro ·
 * Mensual»). Los nombres de precio son únicos en el aula, y la API renombra
 * los que siguen este patrón cuando se renombra el nivel.
 */
export function defaultPlanName(tierName: string, intervalLabel: string): string {
  return `${tierName.trim()} · ${intervalLabel}`.slice(0, PLAN_NAME_MAX);
}

/**
 * Nombre del precio al cambiar la periodicidad: si seguía siendo el de por
 * defecto (o estaba vacío), pasa al de la nueva; si el creador lo escribió a
 * mano, se respeta.
 */
export function followPlanName(
  current: string,
  tierName: string,
  previousLabel: string,
  nextLabel: string,
): string {
  const trimmed = current.trim();
  if (!trimmed || trimmed === defaultPlanName(tierName, previousLabel)) {
    return defaultPlanName(tierName, nextLabel);
  }
  return current;
}

/** Primera periodicidad habitual que el nivel aún no tiene (mensual si las tiene todas). */
export function suggestInterval(
  plans: readonly Pick<MembershipAdminPlan, 'intervalMonths'>[],
): number {
  const used = new Set(plans.map((p) => p.intervalMonths));
  return INTERVAL_PRESETS.find((n) => !used.has(n)) ?? INTERVAL_PRESETS[0]!;
}

/**
 * Moneda de un precio nuevo: la de los precios que ya tiene el nivel; si no
 * tiene, la de cualquier otro nivel; si no hay ninguno, la de por defecto.
 */
export function suggestCurrency(
  tier: Pick<MembershipAdminTier, 'plans'>,
  tiers: readonly Pick<MembershipAdminTier, 'plans'>[],
  fallback: string,
): string {
  const own = tier.plans[0]?.currency;
  if (own) return own;
  for (const other of tiers) {
    const c = other.plans[0]?.currency;
    if (c) return c;
  }
  return fallback;
}

// ── Orden y contenido de los niveles ────────────────────────────────────────

/**
 * Nuevo orden al subir (`-1`) o bajar (`+1`) un nivel. `null` si no se puede
 * mover (ya es el primero o el último, o no está en la lista).
 */
export function moveTier(ids: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next[from] = next[to]!;
  next[to] = id;
  return next;
}

export interface TierCoursesSummary {
  /** Da todos los cursos publicados (también los nuevos). */
  all: boolean;
  /** Títulos de sus cursos publicados, en el orden del catálogo. */
  titles: string[];
  /** Cursos del nivel que no están publicados (no salen en la lista de publicados). */
  hidden: number;
}

/** Lo que incluye un nivel, con los títulos de los cursos publicados del aula. */
export function tierCourses(
  tier: Pick<MembershipAdminTier, 'allCourses' | 'courseIds'>,
  courses: readonly { id: string; title: string }[],
): TierCoursesSummary {
  if (tier.allCourses) return { all: true, titles: [], hidden: 0 };
  const wanted = new Set(tier.courseIds);
  const titles = courses.filter((c) => wanted.has(c.id)).map((c) => c.title);
  return { all: false, titles, hidden: wanted.size - titles.length };
}

// ── Formulario de nivel ─────────────────────────────────────────────────────

export interface TierDraft {
  name: string;
  description: string;
  content: 'all' | 'choose';
  courseIds: string[];
}

export type TierDraftError = 'name' | 'courses';

/**
 * ¿Se puede guardar? Nombre obligatorio y, si se eligen cursos, al menos uno
 * (un nivel sin cursos no da nada). Sin ningún curso publicado en el aula no
 * hay qué elegir: se deja crear vacío y se llena al publicar.
 */
export function validateTierDraft(
  draft: TierDraft,
  opts: { coursesAvailable: boolean },
): TierDraftError | null {
  if (!draft.name.trim()) return 'name';
  if (draft.content === 'choose' && draft.courseIds.length === 0 && opts.coursesAvailable) {
    return 'courses';
  }
  return null;
}

export function tierDraftFromTier(tier: MembershipAdminTier): TierDraft {
  return {
    name: tier.name,
    description: tier.description ?? '',
    content: tier.allCourses ? 'all' : 'choose',
    courseIds: [...tier.courseIds],
  };
}

// ── Formulario de precio ────────────────────────────────────────────────────

export interface PlanDraft {
  name: string;
  intervalMonths: number;
  currency: string;
  amountRaw: string;
  compareAtRaw: string;
  trialDays: string;
  isFeatured: boolean;
  /** Precios fijos por mercado (solo modo completo con cobros de plataforma). */
  marketPrices: CurrencyOptionDraft[];
}

export function newPlanDraft(opts: {
  tierName: string;
  intervalMonths: number;
  intervalLabel: string;
  currency: string;
}): PlanDraft {
  return {
    name: defaultPlanName(opts.tierName, opts.intervalLabel),
    intervalMonths: opts.intervalMonths,
    currency: opts.currency,
    amountRaw: '',
    compareAtRaw: '',
    trialDays: '0',
    isFeatured: false,
    marketPrices: [],
  };
}

export function planDraftFromPlan(plan: MembershipAdminPlan, locale: string): PlanDraft {
  return {
    name: plan.name,
    intervalMonths: plan.intervalMonths,
    currency: plan.currency,
    amountRaw: minorToAmount(plan.amountCents, plan.currency, locale),
    compareAtRaw: minorToAmount(plan.compareAtCents, plan.currency, locale),
    trialDays: String(plan.trialDays),
    isFeatured: plan.isFeatured,
    marketPrices: Object.entries(plan.currencyOptions ?? {}).map(([code, minor]) => ({
      currency: code,
      amount: minorToInput(minor, code, locale),
    })),
  };
}

export type PlanDraftError = 'name' | 'amount' | 'compareAt' | 'trial' | 'market';

export type PlanInputResult =
  | { ok: true; input: Omit<PlanInput, 'tierId'> }
  | { ok: false; error: PlanDraftError; marketErrors: PriceDraftError[] };

/**
 * Del borrador al cuerpo de la API. El precio de un nivel de pago tiene que
 * ser mayor que cero (para entrar sin pagar está el nivel gratis); el tachado,
 * si lo hay, mayor que el precio; los días de prueba, de 0 a 365.
 * `withMarketPrices`: manda también los precios fijos por mercado (modo
 * completo con cobros de plataforma). Sin él, el campo no viaja y la API
 * conserva los que hubiera.
 */
export function buildPlanInput(
  draft: PlanDraft,
  opts: { locale: string; withMarketPrices: boolean },
): PlanInputResult {
  const fail = (error: PlanDraftError, marketErrors: PriceDraftError[] = []): PlanInputResult => ({
    ok: false,
    error,
    marketErrors,
  });
  const name = draft.name.trim();
  if (!name) return fail('name');
  const currency = draft.currency.toLowerCase();
  const amountCents = parseMajorInput(draft.amountRaw, currency, opts.locale);
  if (amountCents === null) return fail('amount');
  let compareAtCents: number | null = null;
  if (draft.compareAtRaw.trim()) {
    compareAtCents = parseMajorInput(draft.compareAtRaw, currency, opts.locale);
    if (compareAtCents === null || compareAtCents <= amountCents) return fail('compareAt');
  }
  const trialText = draft.trialDays.trim() || '0';
  if (!/^\d{1,3}$/.test(trialText) || Number(trialText) > TRIAL_DAYS_MAX) return fail('trial');
  let currencyOptions: Record<string, number> | null | undefined;
  if (opts.withMarketPrices) {
    const market = buildPrice(
      { amount: draft.amountRaw, currency, options: draft.marketPrices },
      opts.locale,
    );
    const marketErrors = market.errors.filter((e) => e.field === 'option');
    if (marketErrors.length) return fail('market', marketErrors);
    currencyOptions = market.currencyOptions;
  }
  return {
    ok: true,
    input: {
      name: name.slice(0, PLAN_NAME_MAX),
      intervalMonths: draft.intervalMonths,
      currency,
      amountCents,
      compareAtCents,
      trialDays: Number(trialText),
      isFeatured: draft.isFeatured,
      ...(currencyOptions !== undefined ? { currencyOptions } : {}),
    },
  };
}
