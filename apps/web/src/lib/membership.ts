/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente de la MEMBRESÍA: página pública /join + administración.
 *
 * Los endpoints públicos van SIN bearer (el visitante no tiene cuenta; el
 * tenant se resuelve por dominio). Los de admin requieren JWT de admin.
 * Importes SIEMPRE en céntimos.
 */

import type { WithdrawalWaiverAcceptance } from '@/lib/purchase-consent';
import { apiFetch } from './api-client';
import { normalizeCheckoutStart, type CheckoutStart, type RawCheckoutStart } from './checkout';
import { formatCents as formatCentsI18n, type FmtOverrides } from './i18n/format';

const PUBLIC_BASE = '/api/v1/membership';
const ADMIN_BASE = '/api/v1/membership/admin';

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface MembershipPlan {
  id: string;
  name: string;
  /** Nivel del plan (Básico, Pro…), o null en un aula sin niveles. */
  tierId?: string | null;
  /** Meses por periodo (1..12): 1 mensual, 3 trimestral, 6 semestral, 12 anual… */
  intervalMonths: number;
  amountCents: number;
  currency: string;
  compareAtCents: number | null;
  trialDays: number;
  isFeatured: boolean;
  /**
   * Solo en `GET /membership/page` y si el aula cobra por la plataforma: `true`
   * cuando el pago enseñará el precio en la moneda del alumno.
   */
  localCurrencyAtCheckout?: boolean;
}

export interface MembershipAdminPlan extends MembershipPlan {
  active: boolean;
  sortOrder: number;
  stripePriceId: string | null;
  /** Precios fijos por mercado: moneda → importe en su unidad mínima. */
  currencyOptions?: Record<string, number> | null;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipCourse {
  id: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  estimatedMinutes: number | null;
  /** Categoría/tema del curso (chips de filtrado), o null. */
  category: string | null;
  moduleCount: number;
  moduleTitles: string[];
  teacherName: string | null;
  amountCents: number | null;
}

/** Tiles con datos REALES del tenant (nada inventado). */
export interface MembershipStats {
  activeMembers: number;
  totalMinutes: number;
}

/** Un curso tal y como se nombra en la tarjeta de un nivel. */
export interface MembershipTierCourse {
  id: string;
  title: string;
  thumbnailUrl: string | null;
}

/**
 * Un nivel de la membresía en /join. `includes` es lo que da el nivel: hoy sus
 * cursos; es un objeto para poder añadir más cosas (espacios de la comunidad,
 * directos) sin romper a quien ya lo lee.
 */
export interface MembershipPublicTier {
  id: string;
  name: string;
  description: string | null;
  isFree: boolean;
  sortOrder: number;
  accessGroupId: string | null;
  includes: {
    /** Todos los cursos publicados (también los nuevos). */
    allCourses: boolean;
    courses: MembershipTierCourse[];
  };
  /** Planes del nivel (ids de `MembershipPage.plans`). Vacío en el gratis. */
  planIds: string[];
}

export interface MembershipPage {
  /** `null`: sin titular propio → el de por defecto del catálogo, en el idioma del aula. */
  headline: string | null;
  subheadline: string | null;
  plans: MembershipPlan[];
  /**
   * Niveles encendidos (con el gratis si lo hay), en su orden. Vacío en un aula
   * sin niveles: la página se pinta como siempre, con `plans`.
   */
  tiers?: MembershipPublicTier[];
  /** «Entrar gratis» del nivel gratis (el registro gratis), o null si está cerrado. */
  freeSignupPath?: string | null;
  courses: MembershipCourse[];
  standaloneTotalCents: number | null;
  stats: MembershipStats;
  testimonial: { quote: string; author: string; role: string | null } | null;
  /** Lecciones visibles por curso durante la prueba (0 = acceso completo). */
  trialLessonLimit: number;
  /**
   * Solo si la instalación cobra por la plataforma: `false` cuando el pago no
   * admite cupones (el aula cobra por la plataforma). Sin el campo, sí admite.
   */
  couponsAtCheckout?: boolean;
}

export interface MembershipConfig {
  tenantId: string;
  active: boolean;
  /** Vacío: el titular por defecto (lo pone la página pública en el idioma del aula). */
  headline: string;
  subheadline: string | null;
  accessGroupId: string | null;
  showCourses: boolean;
  /** Lecciones visibles por curso durante el trial (0 = sin límite). */
  trialLessonLimit: number;
  coursePrices: Array<{ courseId: string; amountCents: number }>;
  testimonialQuote: string | null;
  testimonialAuthor: string | null;
  testimonialRole: string | null;
}

export interface MembershipConfigInput {
  active?: boolean;
  headline?: string;
  subheadline?: string | null;
  accessGroupId?: string | null;
  showCourses?: boolean;
  trialLessonLimit?: number;
  coursePrices?: Array<{ courseId: string; amountCents: number }>;
  testimonialQuote?: string | null;
  testimonialAuthor?: string | null;
  testimonialRole?: string | null;
}

export interface PlanInput {
  name: string;
  /** Nivel del plan (solo al crearlo; luego no cambia). */
  tierId?: string | null;
  intervalMonths: number;
  amountCents: number;
  /** ISO 4217 en minúsculas (p. ej. 'eur', 'usd'). Si falta, la API usa 'eur'. */
  currency?: string;
  compareAtCents?: number | null;
  trialDays?: number;
  active?: boolean;
  isFeatured?: boolean;
  sortOrder?: number;
  /** Precios fijos por mercado (solo cobros de plataforma). `null` = ninguno. */
  currencyOptions?: Record<string, number> | null;
}

/** Un nivel tal y como lo edita el creador (`GET /membership/admin/tiers`). */
export interface MembershipAdminTier {
  id: string;
  name: string;
  description: string | null;
  isFree: boolean;
  sortOrder: number;
  /** Apagado: no se vende; quien ya lo paga conserva su acceso. */
  active: boolean;
  accessGroupId: string | null;
  /** Da todos los cursos publicados (también los nuevos). */
  allCourses: boolean;
  /** Cursos del nivel (vacío con `allCourses`). */
  courseIds: string[];
  plans: MembershipAdminPlan[];
  /** Gente dentro (de pago: membresías vivas; gratis: miembros de su grupo). */
  members: number;
}

export interface MembershipAdminTiers {
  tiers: MembershipAdminTier[];
  /** Planes sin nivel (los de antes): pasan al primer nivel de pago que se cree. */
  legacyPlanCount: number;
  /** El registro gratis (puerta del nivel gratis) encendido y abierto. */
  freeSignup: { moduleEnabled: boolean; open: boolean };
}

export interface CreateTierInput {
  name: string;
  description?: string | null;
  isFree?: boolean;
  allCourses?: boolean;
  courseIds?: string[];
}

export interface UpdateTierInput {
  name?: string;
  description?: string | null;
  active?: boolean;
  courseIds?: string[];
}

/** Lectura pública de los niveles (`GET /membership/tiers`). */
export interface MembershipTierSummary {
  id: string;
  name: string;
  accessGroupId: string | null;
  isFree: boolean;
}

// ── Público ──────────────────────────────────────────────────────────────────

/** Niveles encendidos del aula: id, nombre, grupo que dan y si son gratis. */
export async function getMembershipTiers(): Promise<MembershipTierSummary[]> {
  const res = await apiFetch<{ tiers: MembershipTierSummary[] }>(`${PUBLIC_BASE}/tiers`, {
    method: 'GET',
  });
  return res.tiers;
}

export async function getMembershipPage(): Promise<MembershipPage> {
  return apiFetch<MembershipPage>(`${PUBLIC_BASE}/page`, { method: 'GET' });
}

export async function startMembershipCheckout(
  planId: string,
  email?: string,
  referralCode?: string,
  /** La casilla de la renuncia al desistimiento (la API la exige). */
  withdrawalWaiver?: WithdrawalWaiverAcceptance,
  /** `embedded`: pagar dentro de /join si el servidor puede; si no, redirect. */
  uiMode?: 'embedded' | 'hosted',
): Promise<CheckoutStart> {
  const raw = await apiFetch<RawCheckoutStart>(`${PUBLIC_BASE}/checkout`, {
    method: 'POST',
    body: JSON.stringify({
      planId,
      ...(email ? { email } : {}),
      ...(referralCode ? { referralCode } : {}),
      ...(withdrawalWaiver ? { withdrawalWaiver } : {}),
      ...(uiMode ? { uiMode } : {}),
    }),
  });
  return normalizeCheckoutStart(raw);
}

// ── Admin ────────────────────────────────────────────────────────────────────

export const membershipAdminApi = {
  async listPlans(bearer: string): Promise<MembershipAdminPlan[]> {
    const res = await apiFetch<{ plans: MembershipAdminPlan[] }>(
      `${ADMIN_BASE}/plans`,
      { method: 'GET' },
      bearer,
    );
    return res.plans;
  },
  async createPlan(bearer: string, input: PlanInput): Promise<MembershipAdminPlan> {
    return apiFetch(`${ADMIN_BASE}/plans`, { method: 'POST', body: JSON.stringify(input) }, bearer);
  },
  async updatePlan(
    bearer: string,
    id: string,
    input: Partial<PlanInput>,
  ): Promise<MembershipAdminPlan> {
    return apiFetch(
      `${ADMIN_BASE}/plans/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      bearer,
    );
  },
  async deletePlan(bearer: string, id: string): Promise<void> {
    await apiFetch(`${ADMIN_BASE}/plans/${encodeURIComponent(id)}`, { method: 'DELETE' }, bearer);
  },
  async getConfig(bearer: string): Promise<MembershipConfig> {
    return apiFetch(`${ADMIN_BASE}/config`, { method: 'GET' }, bearer);
  },
  async updateConfig(bearer: string, input: MembershipConfigInput): Promise<MembershipConfig> {
    return apiFetch(`${ADMIN_BASE}/config`, { method: 'PUT', body: JSON.stringify(input) }, bearer);
  },

  // ── Niveles ──
  async listTiers(bearer: string): Promise<MembershipAdminTiers> {
    return apiFetch(`${ADMIN_BASE}/tiers`, { method: 'GET' }, bearer);
  },
  async createTier(bearer: string, input: CreateTierInput): Promise<MembershipAdminTier> {
    return apiFetch(`${ADMIN_BASE}/tiers`, { method: 'POST', body: JSON.stringify(input) }, bearer);
  },
  async updateTier(
    bearer: string,
    id: string,
    input: UpdateTierInput,
  ): Promise<MembershipAdminTier> {
    return apiFetch(
      `${ADMIN_BASE}/tiers/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      bearer,
    );
  },
  async reorderTiers(bearer: string, tierIds: string[]): Promise<MembershipAdminTiers> {
    return apiFetch(
      `${ADMIN_BASE}/tiers/order`,
      { method: 'PUT', body: JSON.stringify({ tierIds }) },
      bearer,
    );
  },
  /** Con alumnos dentro la API responde 409 (`MEMBERSHIP_TIER_IN_USE`): se apaga en su lugar. */
  async deleteTier(bearer: string, id: string): Promise<void> {
    await apiFetch(`${ADMIN_BASE}/tiers/${encodeURIComponent(id)}`, { method: 'DELETE' }, bearer);
  },
};

// ── Helpers de formato ───────────────────────────────────────────────────────

/**
 * Céntimos → importe en el LOCALE ACTIVO ("999 €" / "$999"). Delega en la
 * conversión canónica de `@/lib/i18n/format`: la regla de decimales («sin
 * decimales si la cantidad es redonda») vive allí y solo allí, y coincide con
 * la que este wrapper aplicaba a mano — el español sale byte a byte igual.
 *
 * `opts` es OPCIONAL y solo reenvía overrides a la canónica. Lo necesitan las
 * pantallas de `(public)`/`(venta)`, que sí se pintan en SSR: allí el singleton
 * de `user-prefs` está vacío a propósito y hay que pasar `{ locale }` explícito
 * para que servidor y cliente pinten el mismo importe.
 */
export function formatCents(
  cents: number,
  currency = 'eur',
  opts?: Intl.NumberFormatOptions & FmtOverrides,
): string {
  return formatCentsI18n(cents, currency.toUpperCase(), opts);
}
