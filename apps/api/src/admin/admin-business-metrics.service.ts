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

export interface CurrencyRevenue {
  /** Código ISO 4217 en minúsculas, como lo guarda Stripe (`eur`, `chf`…). */
  currency: string;
  /**
   * Cobrado en 30 días (cursos + membresía) en la unidad mínima de la moneda
   * según Stripe (céntimos en EUR; yenes en JPY, que no tiene decimales).
   */
  totalMinor30d: number;
  /** Serie de 12 semanas en la misma unidad mínima. */
  weekly: WeeklyPoint[];
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
    /**
     * Una entrada por moneda cobrada en la ventana de 12 semanas. Nunca se
     * suman importes de monedas distintas. Lista vacía si no hubo cobros.
     * Orden: ver `revenueByCurrency`.
     */
    byCurrency: CurrencyRevenue[];
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

/**
 * Agrupa los cobros por moneda sin sumar monedas entre sí: cada moneda lleva
 * su total de 30 días y su serie semanal, en su propia unidad mínima.
 *
 * Orden estable: primero la moneda con MÁS COBROS en la ventana de 12 semanas
 * (la principal del aula) y, a igualdad, alfabético por código. No se ordena
 * por importe porque comparar unidades mínimas de monedas distintas no tiene
 * sentido (1.000 JPY ≈ 6 EUR, pero 1.000 > 600 céntimos).
 */
export function revenueByCurrency(
  events: Array<{ at: Date; value: number; currency: string }>,
  weeks: number,
  now: Date,
  since30d: Date,
): CurrencyRevenue[] {
  const groups = new Map<string, Array<{ at: Date; value: number }>>();
  for (const e of events) {
    const currency = e.currency.trim().toLowerCase();
    const list = groups.get(currency) ?? [];
    list.push({ at: e.at, value: e.value });
    groups.set(currency, list);
  }
  return [...groups.entries()]
    .sort(([a, ea], [b, eb]) => eb.length - ea.length || a.localeCompare(b))
    .map(([currency, list]) => ({
      currency,
      totalMinor30d: list.filter((e) => e.at >= since30d).reduce((sum, e) => sum + e.value, 0),
      weekly: bucketByWeek(list, weeks, now),
    }));
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
        select: { amountPaid: true, currency: true, completedAt: true },
      }),
      // …más facturas de membresía cobradas.
      this.prisma.modSubscriptionsInvoice.findMany({
        where: { tenantId, paidAt: { not: null, gte: sinceWeeks } },
        select: { amount: true, currency: true, paidAt: true },
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

    // Cada cobro con SU moneda: un aula con cobros de plataforma puede vender
    // en EUR, CHF, USD… y sumarlas daría una cifra sin sentido.
    const revenueEvents = [
      ...orders.map((o) => ({
        at: o.completedAt!,
        value: o.amountPaid ?? 0,
        currency: o.currency,
      })),
      ...invoices.map((i) => ({ at: i.paidAt!, value: i.amount, currency: i.currency })),
    ];

    return {
      generatedAt: now.toISOString(),
      nps: computeNps(npsAnswers.map((a) => a.valueInt!)),
      revenue: { byCurrency: revenueByCurrency(revenueEvents, WEEKS, now, since30d) },
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
