'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente del expediente de usuario. Backend:
 * `apps/api/src/moderation/dossier.service.ts`.
 *
 * Solo lo pueden pedir admins y cada consulta queda auditada en el servidor.
 */

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import type { Restriction } from './restrictions';

export interface DossierOrder {
  id: string;
  courseId: string;
  courseTitle: string | null;
  status: string;
  amountPaid: number | null;
  currency: string;
  completedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
}

export interface DossierSubscription {
  id: string;
  courseId: string | null;
  planName: string | null;
  status: string;
  unitAmount: number;
  currency: string;
  interval: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  canceledAt: string | null;
  daysToRenewal: number | null;
}

/** Compra hecha en la tienda externa (WooCommerce), reflejada por el espejo. */
export interface DossierExternalOrder {
  id: string;
  provider: string;
  externalId: string;
  status: string;
  paid: boolean;
  totalAmount: number;
  currency: string;
  placedAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  entitlementKind: string;
  accessEndsAt: string | null;
  daysToExpiry: number | null;
  products: string[];
}

/** Etiquetas de los tipos de derecho de acceso. Espejo de `KIND_LABELS` en la API. */
export const ENTITLEMENT_LABELS: Record<string, string> = {
  LIFETIME: 'Acceso permanente',
  SUBSCRIPTION: 'Suscripción',
  TIMED: 'Acceso con vigencia',
  ONE_OFF: 'Compra suelta',
  INFRA: 'Servicio',
};

/** Estados de WooCommerce en cristiano. */
export const WOO_STATUS_LABELS: Record<string, string> = {
  completed: 'Pagado',
  processing: 'Pagado (en curso)',
  refunded: 'Devuelto',
  cancelled: 'Cancelado',
  failed: 'Fallido',
  pending: 'Pendiente de pago',
  'on-hold': 'En espera',
  'lead-magnet': 'Gratuito',
};

export interface UserDossier {
  identity: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    bio: string | null;
    jobTitle: string | null;
    department: string | null;
    location: string | null;
    status: string;
    roles: string[];
    emailVerified: boolean;
    mfaEnabled: boolean;
    locale: string;
    timezone: string;
    documentId: string | null;
    externalSource: string | null;
    externalId: string | null;
    createdAt: string;
    lastLoginAt: string | null;
    onboardingCompletedAt: string | null;
    membershipDays: number;
  };
  commerce: {
    orders: DossierOrder[];
    totalPaidCents: number;
    subscriptions: DossierSubscription[];
    externalSubscriptions: Array<{
      provider: string;
      productName: string | null;
      status: string;
      entitled: boolean;
      currentPeriodEnd: string | null;
    }>;
    externalOrders: DossierExternalOrder[];
    totalPaidExternalCents: number;
    customerSince: string | null;
  };
  learning: {
    enrollments: Array<{
      /** Id de la matrícula — lo usa la baja administrativa desde la ficha. */
      id: string;
      courseId: string;
      courseTitle: string | null;
      status: string;
      /** ADMIN | CODE | INVITATION_LINK | PURCHASE | IMPORT | SUBSCRIPTION | API | GROUP */
      source: string;
      progressPercent: number;
      enrolledAt: string;
      completedAt: string | null;
    }>;
    certificates: Array<{
      id: string;
      courseId: string;
      number: string;
      issuedAt: string;
      revokedAt: string | null;
    }>;
    quizAttempts: Array<{
      id: string;
      quizId: string;
      scorePercent: number | null;
      passed: boolean | null;
      submittedAt: string | null;
    }>;
    liveAttendance: Array<{
      sessionId: string;
      present: boolean;
      minutes: number | null;
      joinedAt: string | null;
    }>;
  };
  activity: {
    counts: {
      posts: number;
      comments: number;
      reactions: number;
      messages: number;
      lessonComments: number;
      resources: number;
      aiQuestions: number;
    };
    posts: Array<{
      id: string;
      title: string | null;
      body: string;
      createdAt: string;
      hiddenAt: string | null;
      deletedAt: string | null;
    }>;
    comments: Array<{
      id: string;
      postId: string;
      body: string;
      createdAt: string;
      hiddenAt: string | null;
      deletedAt: string | null;
    }>;
  };
  messages: {
    total: number;
    recent: Array<{
      id: string;
      conversationId: string;
      conversationType: string;
      body: string;
      kind: string;
      createdAt: string;
      deletedAt: string | null;
    }>;
  };
  gamification: {
    lifetimePoints: number;
    levelKey: string | null;
    levelReachedAt: string | null;
  } | null;
  access: {
    recentSessions: Array<{
      id: string;
      createdAt: string;
      expiresAt: string;
      ip: string | null;
      userAgent: string | null;
    }>;
    externalIdentities: Array<{
      provider: string;
      issuer: string;
      linkedAt: string;
      lastSeenAt: string | null;
    }>;
  };
  /** Grupos de acceso ACTIVOS del usuario (mod.access-groups). */
  accessGroups: Array<{
    groupId: string;
    slug: string;
    name: string;
    kind: string;
    /** MANUAL (alta del admin) | TIER (vínculo tier→grupo) | MEMBERSHIP (membresía de pago). */
    source: string;
    grantedAt: string;
  }>;
  restrictions: Restriction[];
}

export const dossierApi = {
  get(userId: string): Promise<UserDossier> {
    return apiFetch<UserDossier>(
      `/api/v1/admin/users/${encodeURIComponent(userId)}/dossier`,
      { method: 'GET' },
      authStorage.getAccessToken() ?? undefined,
    );
  },
};

/** Céntimos → «119,00 €». */
export function formatMoney(cents: number | null, currency = 'eur'): string {
  if (cents === null) return '—';
  return (cents / 100).toLocaleString('es-ES', {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
}

/** «hace 3 meses», «hace 2 años»: la antigüedad se lee mejor que 847 días. */
export function formatMembership(days: number): string {
  if (days < 1) return 'hoy';
  if (days === 1) return '1 día';
  if (days < 30) return `${days} días`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? '1 mes' : `${months} meses`;
  const years = Math.floor(days / 365);
  const restMonths = Math.floor((days % 365) / 30);
  const y = years === 1 ? '1 año' : `${years} años`;
  return restMonths > 0 ? `${y} y ${restMonths} ${restMonths === 1 ? 'mes' : 'meses'}` : y;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES');
}
