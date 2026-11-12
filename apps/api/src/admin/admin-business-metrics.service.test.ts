import { describe, expect, it } from 'vitest';
import {
  AdminBusinessMetricsService,
  bucketByWeek,
  computeNps,
  revenueByCurrency,
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

  type Order = { amountPaid: number | null; currency: string; completedAt: Date };
  type Invoice = { amount: number; currency: string; paidAt: Date };

  // Aula solo-EUR: los mismos importes que antes de agrupar por moneda.
  const EUR_ORDERS: Order[] = [
    { amountPaid: 11900, currency: 'eur', completedAt: days(2) },
    { amountPaid: 11900, currency: 'eur', completedAt: days(40) }, // fuera de 30d, dentro de 12 semanas
  ];
  const EUR_INVOICES: Invoice[] = [{ amount: 2900, currency: 'eur', paidAt: days(5) }];

  function makePrisma(orders: Order[] = EUR_ORDERS, invoices: Invoice[] = EUR_INVOICES) {
    return {
      modSurveysAnswer: {
        findMany: async () => [{ valueInt: 10 }, { valueInt: 9 }, { valueInt: 3 }],
      },
      modBillingOrder: { findMany: async () => orders },
      modSubscriptionsInvoice: { findMany: async () => invoices },
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
    // Solo EUR → una única moneda con las mismas cifras de siempre.
    expect(m.revenue.byCurrency).toHaveLength(1);
    const eur = m.revenue.byCurrency[0]!;
    expect(eur.currency).toBe('eur');
    expect(eur.totalMinor30d).toBe(14800);
    expect(eur.weekly).toHaveLength(12);
    expect(eur.weekly.reduce((s, p) => s + p.value, 0)).toBe(26700);

    expect(m.arrears).toEqual({ subscriptions: 3, external: 4, total: 7 });
    expect(m.members.newMembers30d).toBe(12);
    expect(m.members.cancellations30d).toBe(2);
    expect(m.members.weeklySignups.reduce((s, p) => s + p.value, 0)).toBe(2);
    expect(m.connections).toEqual({ active7d: 20, active30d: 45, totalActive: 120 });
    expect(m.aiTutor).toEqual({ activeUsers30d: 2, questions30d: 57 });
    expect(m.community.posts30d).toBe(9);
  });

  it('con EUR y CHF da una línea por moneda y nunca las suma', async () => {
    const service = new AdminBusinessMetricsService(
      makePrisma(
        [
          { amountPaid: 11900, currency: 'eur', completedAt: days(2) },
          { amountPaid: 9900, currency: 'CHF', completedAt: days(3) }, // mayúsculas → se normaliza
        ],
        [
          { amount: 2900, currency: 'eur', paidAt: days(5) },
          { amount: 3500, currency: 'chf', paidAt: days(6) },
          { amount: 3500, currency: 'chf', paidAt: days(50) }, // fuera de 30d
        ],
      ) as never,
    );
    const m = await service.getMetrics('tenant-1', now);

    // CHF tiene 3 cobros en la ventana y EUR 2 → CHF primero.
    expect(m.revenue.byCurrency.map((r) => r.currency)).toEqual(['chf', 'eur']);
    const [chf, eur] = m.revenue.byCurrency;
    expect(chf!.totalMinor30d).toBe(13400);
    expect(chf!.weekly.reduce((s, p) => s + p.value, 0)).toBe(16900);
    expect(eur!.totalMinor30d).toBe(14800);
    expect(eur!.weekly.reduce((s, p) => s + p.value, 0)).toBe(14800);
  });

  it('sin cobros devuelve la lista vacía', async () => {
    const service = new AdminBusinessMetricsService(makePrisma([], []) as never);
    const m = await service.getMetrics('tenant-1', now);
    expect(m.revenue.byCurrency).toEqual([]);
  });
});

describe('revenueByCurrency', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const since30d = new Date(now.getTime() - 30 * 24 * 3_600_000);
  const at = new Date('2026-07-28T09:00:00Z');

  it('deja los importes de JPY (sin decimales) tal cual, sin dividir', () => {
    const [jpy] = revenueByCurrency([{ at, value: 4500, currency: 'jpy' }], 4, now, since30d);
    expect(jpy).toMatchObject({ currency: 'jpy', totalMinor30d: 4500 });
    expect(jpy!.weekly.at(-1)!.value).toBe(4500);
  });

  it('a igualdad de cobros ordena alfabéticamente; nunca por importe', () => {
    const rows = revenueByCurrency(
      [
        { at, value: 1_000_000, currency: 'jpy' },
        { at, value: 100, currency: 'usd' },
        { at, value: 100, currency: 'chf' },
        { at, value: 100, currency: 'eur' },
        { at, value: 100, currency: 'eur' },
      ],
      4,
      now,
      since30d,
    );
    expect(rows.map((r) => r.currency)).toEqual(['eur', 'chf', 'jpy', 'usd']);
  });
});
