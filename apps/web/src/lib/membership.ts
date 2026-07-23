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
  /** 1 (mensual) | 3 (trimestral) | 12 (anual). */
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
}

export interface MembershipConfig {
  tenantId: string;
  active: boolean;
  headline: string;
  subheadline: string | null;
  accessGroupId: string | null;
  showCourses: boolean;
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
  coursePrices?: Array<{ courseId: string; amountCents: number }>;
  testimonialQuote?: string | null;
  testimonialAuthor?: string | null;
  testimonialRole?: string | null;
}

export interface PlanInput {
  name: string;
  intervalMonths: number;
  amountCents: number;
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
): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(`${PUBLIC_BASE}/checkout`, {
    method: 'POST',
    body: JSON.stringify(email ? { planId, email } : { planId }),
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

/** Etiqueta de periodicidad: "/mes", "/trimestre", "/año". */
export function intervalSuffix(intervalMonths: number): string {
  if (intervalMonths === 12) return '/año';
  if (intervalMonths === 3) return '/trimestre';
  return '/mes';
}

/** Nombre largo: "Suscripción mensual/trimestral/anual". */
export function intervalDescription(intervalMonths: number): string {
  if (intervalMonths === 12) return 'Suscripción anual';
  if (intervalMonths === 3) return 'Suscripción trimestral';
  return 'Suscripción mensual';
}

/** Fecha del próximo pago: hoy + trial + periodo. */
export function nextPaymentDate(intervalMonths: number, trialDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + trialDays);
  d.setMonth(d.getMonth() + intervalMonths);
  return d;
}
