/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Bloque 7 — panel de métricas del negocio (doc/mejoras.md): pocos KPIs que se
 * miran todos los lunes, todos calculados de la BD LOCAL (los webhooks de
 * Stripe/Woo ya materializan estado; no se llama a ninguna API externa).
 *
 * Composición en el host a propósito: agrega datos de varios módulos
 * (surveys, billing, subscriptions, payment-connections, ai-tutor, community)
 * y del core (users), algo que ningún módulo puede hacer por contrato.
 */

const WEEKS = 12;
const DAY_MS = 24 * 3_600_000;

export interface WeeklyPoint {
  /** Lunes (UTC) de la semana, ISO YYYY-MM-DD. */
  weekStart: string;
  value: number;
}

export interface BusinessMetrics {
  generatedAt: string;
  nps: {
    /** Promotores − detractores en puntos (-100..100). Null sin respuestas. */
    score: number | null;
    responses: number;
    promoters: number;
    passives: number;
    detractors: number;
  };
  revenue: {
    /** Céntimos cobrados en 30 días (cursos + membresía). */
    totalCents30d: number;
    currency: string;
    weekly: WeeklyPoint[];
  };
  arrears: {
    /** Suscripciones locales PAST_DUE/UNPAID (mod.subscriptions). */
    subscriptions: number;
    /** Suscriptores externos past_due/unpaid (Stripe/Woo/PayPal sync). */
    external: number;
    total: number;
  };
  members: {
    newMembers30d: number;
    cancellations30d: number;
    weeklySignups: WeeklyPoint[];
  };
  connections: {
    active7d: number;
    active30d: number;
    totalActive: number;
  };
  aiTutor: {
    activeUsers30d: number;
    questions30d: number;
  };
  community: {
    posts30d: number;
  };
}

/** Lunes (UTC) de la semana de una fecha, como YYYY-MM-DD. */
export function weekStartUtc(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay(); // 0=domingo … 6=sábado
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7)); // retrocede al lunes
  return d.toISOString().slice(0, 10);
}

/**
 * Serie de las últimas `weeks` semanas (todas presentes, a 0 si no hay datos),
 * sumando `value` por semana del evento. Determinista para `now` fijo (tests).
 */
export function bucketByWeek(
  events: Array<{ at: Date; value: number }>,
  weeks: number,
  now: Date,
): WeeklyPoint[] {
  const buckets = new Map<string, number>();
  for (let i = weeks - 1; i >= 0; i--) {
    buckets.set(weekStartUtc(new Date(now.getTime() - i * 7 * DAY_MS)), 0);
  }
  for (const e of events) {
    const key = weekStartUtc(e.at);
    if (buckets.has(key)) buckets.set(key, buckets.get(key)! + e.value);
  }
  return [...buckets.entries()].map(([weekStart, value]) => ({ weekStart, value }));
}

/** NPS clásico sobre valores 0-10: %promotores(9-10) − %detractores(0-6). */
export function computeNps(values: number[]): BusinessMetrics['nps'] {
  const promoters = values.filter((v) => v >= 9).length;
  const passives = values.filter((v) => v >= 7 && v <= 8).length;
  const detractors = values.filter((v) => v <= 6).length;
  return {
    score:
      values.length === 0 ? null : Math.round(((promoters - detractors) / values.length) * 100),
    responses: values.length,
    promoters,
    passives,
    detractors,
  };
}

@Injectable()
export class AdminBusinessMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(tenantId: string, now = new Date()): Promise<BusinessMetrics> {
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const since30d = new Date(now.getTime() - 30 * DAY_MS);
    const sinceWeeks = new Date(now.getTime() - WEEKS * 7 * DAY_MS);

    const [
      npsAnswers,
      orders,
      invoices,
      arrearsSubscriptions,
      arrearsExternal,
      newMembers30d,
      cancellations30d,
      signups,
      active7d,
      active30d,
      totalActive,
      aiUsers,
      aiQuestions,
      posts30d,
    ] = await Promise.all([
      // NPS (30d): solo respuestas a preguntas tipo NPS. Anónimas — aquí solo
      // llegan valores agregables, nunca autores.
      this.prisma.modSurveysAnswer.findMany({
        where: {
          tenantId,
          valueInt: { not: null },
          question: { type: 'NPS' },
          response: { submittedAt: { gte: since30d } },
        },
        select: { valueInt: true },
      }),
      // Ventas: pagos únicos de cursos (completados y no reembolsados)…
      this.prisma.modBillingOrder.findMany({
        where: { tenantId, completedAt: { not: null, gte: sinceWeeks }, refundedAt: null },
        select: { amountPaid: true, completedAt: true },
      }),
      // …más facturas de membresía cobradas.
      this.prisma.modSubscriptionsInvoice.findMany({
        where: { tenantId, paidAt: { not: null, gte: sinceWeeks } },
        select: { amount: true, paidAt: true },
      }),
      this.prisma.modSubscriptionsSubscription.count({
        where: { tenantId, status: { in: ['PAST_DUE', 'UNPAID'] } },
      }),
      this.prisma.modPaymentConnectionsSubscriber.count({
        where: { tenantId, statusCategory: { in: ['past_due', 'unpaid'] } },
      }),
      this.prisma.user.count({ where: { tenantId, createdAt: { gte: since30d } } }),
      this.prisma.modSubscriptionsSubscription.count({
        where: { tenantId, canceledAt: { gte: since30d } },
      }),
      this.prisma.user.findMany({
        where: { tenantId, createdAt: { gte: sinceWeeks } },
        select: { createdAt: true },
      }),
      this.prisma.user.count({
        where: { tenantId, status: 'ACTIVE', deletedAt: null, lastLoginAt: { gte: since7d } },
      }),
      this.prisma.user.count({
        where: { tenantId, status: 'ACTIVE', deletedAt: null, lastLoginAt: { gte: since30d } },
      }),
      this.prisma.user.count({ where: { tenantId, status: 'ACTIVE', deletedAt: null } }),
      this.prisma.modAiTutorTokenUsage.findMany({
        where: { tenantId, userId: { not: null }, day: { gte: since30d } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.modAiTutorMessage.count({
        where: { tenantId, role: 'user', createdAt: { gte: since30d } },
      }),
      // Actividad bruta: posts creados (incluidos los luego moderados — miden
      // actividad, no calidad).
      this.prisma.modCommunityPost.count({
        where: { tenantId, createdAt: { gte: since30d } },
      }),
    ]);

    const revenueEvents = [
      ...orders.map((o) => ({ at: o.completedAt!, value: o.amountPaid ?? 0 })),
      ...invoices.map((i) => ({ at: i.paidAt!, value: i.amount })),
    ];
    const revenueWeekly = bucketByWeek(revenueEvents, WEEKS, now);
    const totalCents30d = revenueEvents
      .filter((e) => e.at >= since30d)
      .reduce((sum, e) => sum + e.value, 0);

    return {
      generatedAt: now.toISOString(),
      nps: computeNps(npsAnswers.map((a) => a.valueInt!)),
      revenue: { totalCents30d, currency: 'eur', weekly: revenueWeekly },
      arrears: {
        subscriptions: arrearsSubscriptions,
        external: arrearsExternal,
        total: arrearsSubscriptions + arrearsExternal,
      },
      members: {
        newMembers30d,
        cancellations30d,
        weeklySignups: bucketByWeek(
          signups.map((s) => ({ at: s.createdAt, value: 1 })),
          WEEKS,
          now,
        ),
      },
      connections: { active7d, active30d, totalActive },
      aiTutor: { activeUsers30d: aiUsers.length, questions30d: aiQuestions },
      community: { posts30d },
    };
  }
}
