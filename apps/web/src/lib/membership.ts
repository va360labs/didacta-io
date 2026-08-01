/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente de la MEMBRESÍA: página pública /unete + administración.
 *
 * Los endpoints públicos van SIN bearer (el visitante no tiene cuenta; el
 * tenant se resuelve por dominio). Los de admin requieren JWT de admin.
 * Importes SIEMPRE en céntimos.
 */

import { apiFetch } from './api-client';

const PUBLIC_BASE = '/api/v1/membership';
const ADMIN_BASE = '/api/v1/membership/admin';

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface MembershipPlan {
  id: string;
  name: string;
  /** Meses por periodo (1..12): 1 mensual, 3 trimestral, 6 semestral, 12 anual… */
  intervalMonths: number;
  amountCents: number;
  currency: string;
  compareAtCents: number | null;
  trialDays: number;
  isFeatured: boolean;
}

export interface MembershipAdminPlan extends MembershipPlan {
  active: boolean;
  sortOrder: number;
  stripePriceId: string | null;
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

export interface MembershipPage {
  headline: string;
  subheadline: string | null;
  plans: MembershipPlan[];
  courses: MembershipCourse[];
  standaloneTotalCents: number | null;
  stats: MembershipStats;
  testimonial: { quote: string; author: string; role: string | null } | null;
  /** Lecciones visibles por curso durante la prueba (0 = acceso completo). */
  trialLessonLimit: number;
}

export interface MembershipConfig {
  tenantId: string;
  active: boolean;
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
  intervalMonths: number;
  amountCents: number;
  /** ISO 4217 en minúsculas (p. ej. 'eur', 'usd'). Si falta, la API usa 'eur'. */
  currency?: string;
  compareAtCents?: number | null;
  trialDays?: number;
  active?: boolean;
  isFeatured?: boolean;
  sortOrder?: number;
}

// ── Público ──────────────────────────────────────────────────────────────────

export async function getMembershipPage(): Promise<MembershipPage> {
  return apiFetch<MembershipPage>(`${PUBLIC_BASE}/page`, { method: 'GET' });
}

export async function startMembershipCheckout(
  planId: string,
  email?: string,
  referralCode?: string,
): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(`${PUBLIC_BASE}/checkout`, {
    method: 'POST',
    body: JSON.stringify({
      planId,
      ...(email ? { email } : {}),
      ...(referralCode ? { referralCode } : {}),
    }),
  });
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
};

// ── Helpers de formato ───────────────────────────────────────────────────────

/** "999,00 €" a partir de céntimos. */
export function formatCents(cents: number, currency = 'eur'): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** Etiqueta de periodicidad: "/mes", "/trimestre", …, "/N meses". */
export function intervalSuffix(intervalMonths: number): string {
  if (intervalMonths === 12) return '/año';
  if (intervalMonths === 6) return '/semestre';
  if (intervalMonths === 3) return '/trimestre';
  if (intervalMonths === 1) return '/mes';
  return `/${intervalMonths} meses`;
}

/** Nombre largo: "Suscripción mensual/trimestral/…/cada N meses". */
export function intervalDescription(intervalMonths: number): string {
  if (intervalMonths === 12) return 'Suscripción anual';
  if (intervalMonths === 6) return 'Suscripción semestral';
  if (intervalMonths === 3) return 'Suscripción trimestral';
  if (intervalMonths === 1) return 'Suscripción mensual';
  return `Suscripción cada ${intervalMonths} meses`;
}

/** Fecha del próximo pago: hoy + trial + periodo. */
export function nextPaymentDate(intervalMonths: number, trialDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + trialDays);
  d.setMonth(d.getMonth() + intervalMonths);
  return d;
}
