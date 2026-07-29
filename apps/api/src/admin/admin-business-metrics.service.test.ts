import { describe, expect, it } from 'vitest';
import {
  AdminBusinessMetricsService,
  bucketByWeek,
  computeNps,
  weekStartUtc,
} from './admin-business-metrics.service';

// ============================================================================
// Bloque 7 — tests del panel de métricas: helpers puros (semanas UTC, NPS) y
// el agregado completo con un prisma simulado (sin BD ni red).
// ============================================================================

describe('weekStartUtc', () => {
  it('devuelve el lunes UTC de la semana', () => {
    expect(weekStartUtc(new Date('2026-07-29T10:00:00Z'))).toBe('2026-07-27'); // miércoles → lunes
    expect(weekStartUtc(new Date('2026-07-27T00:00:00Z'))).toBe('2026-07-27'); // lunes → sí mismo
    expect(weekStartUtc(new Date('2026-07-26T23:59:59Z'))).toBe('2026-07-20'); // domingo → lunes anterior
  });
});

describe('bucketByWeek', () => {
  const now = new Date('2026-07-29T12:00:00Z');

  it('genera todas las semanas de la ventana a 0 y suma por semana', () => {
    const points = bucketByWeek(
      [
        { at: new Date('2026-07-28T09:00:00Z'), value: 100 }, // semana actual
        { at: new Date('2026-07-27T00:30:00Z'), value: 50 }, // misma semana
        { at: new Date('2026-07-21T12:00:00Z'), value: 25 }, // semana anterior
      ],
      4,
      now,
    );
    expect(points).toHaveLength(4);
    expect(points.at(-1)).toEqual({ weekStart: '2026-07-27', value: 150 });
    expect(points.at(-2)).toEqual({ weekStart: '2026-07-20', value: 25 });
    expect(points[0]!.value).toBe(0);
  });

  it('ignora eventos fuera de la ventana', () => {
    const points = bucketByWeek([{ at: new Date('2020-01-01T00:00:00Z'), value: 999 }], 4, now);
    expect(points.every((p) => p.value === 0)).toBe(true);
  });
});

describe('computeNps', () => {
  it('score null sin respuestas', () => {
    expect(computeNps([]).score).toBeNull();
  });

  it('promotores(9-10) − detractores(0-6) en puntos', () => {
    // 2 promotores, 1 pasivo, 1 detractor → (2-1)/4 = 25.
    expect(computeNps([10, 9, 7, 2])).toEqual({
      score: 25,
      responses: 4,
      promoters: 2,
      passives: 1,
      detractors: 1,
    });
    expect(computeNps([10, 10]).score).toBe(100);
    expect(computeNps([0, 1]).score).toBe(-100);
  });
});

describe('AdminBusinessMetricsService.getMetrics', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const days = (n: number) => new Date(now.getTime() - n * 24 * 3_600_000);

  function makePrisma() {
    return {
      modSurveysAnswer: {
        findMany: async () => [{ valueInt: 10 }, { valueInt: 9 }, { valueInt: 3 }],
      },
      modBillingOrder: {
        findMany: async () => [
          { amountPaid: 11900, completedAt: days(2) },
          { amountPaid: 11900, completedAt: days(40) }, // fuera de 30d, dentro de 12 semanas
        ],
      },
      modSubscriptionsInvoice: {
        findMany: async () => [{ amount: 2900, paidAt: days(5) }],
      },
      modSubscriptionsSubscription: {
        count: async ({ where }: { where: Record<string, unknown> }) =>
          'canceledAt' in where ? 2 : 3, // 2 bajas 30d · 3 impagos
      },
      modPaymentConnectionsSubscriber: { count: async () => 4 },
      user: {
        count: async ({ where }: { where: Record<string, unknown> }) => {
          if ('createdAt' in where) return 12; // altas 30d
          if ('lastLoginAt' in where) {
            const gte = (where['lastLoginAt'] as { gte: Date }).gte;
            return gte >= days(8) ? 20 : 45; // 7d vs 30d
          }
          return 120; // total activos
        },
        findMany: async () => [{ createdAt: days(1) }, { createdAt: days(2) }],
      },
      modAiTutorTokenUsage: { findMany: async () => [{ userId: 'u1' }, { userId: 'u2' }] },
      modAiTutorMessage: { count: async () => 57 },
      modCommunityPost: { count: async () => 9 },
    };
  }

  it('agrega todos los KPIs con las formas esperadas', async () => {
    const service = new AdminBusinessMetricsService(makePrisma() as never);
    const m = await service.getMetrics('tenant-1', now);

    expect(m.nps).toEqual({ score: 33, responses: 3, promoters: 2, passives: 0, detractors: 1 });

    // 30d: 11900 (orden reciente) + 2900 (factura) — la orden de hace 40 días
    // cuenta en la serie semanal pero NO en el total de 30 días.
    expect(m.revenue.totalCents30d).toBe(14800);
    expect(m.revenue.weekly).toHaveLength(12);
    expect(m.revenue.weekly.reduce((s, p) => s + p.value, 0)).toBe(26700);

    expect(m.arrears).toEqual({ subscriptions: 3, external: 4, total: 7 });
    expect(m.members.newMembers30d).toBe(12);
    expect(m.members.cancellations30d).toBe(2);
    expect(m.members.weeklySignups.reduce((s, p) => s + p.value, 0)).toBe(2);
    expect(m.connections).toEqual({ active7d: 20, active30d: 45, totalActive: 120 });
    expect(m.aiTutor).toEqual({ activeUsers30d: 2, questions30d: 57 });
    expect(m.community.posts30d).toBe(9);
  });
});
