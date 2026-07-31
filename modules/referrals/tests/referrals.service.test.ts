import { beforeEach, describe, expect, it } from 'vitest';
import {
  ReferralsService,
  utcDay,
  type ReferralsEventPublisher,
} from '../src/referrals.service.js';
import {
  ReferralsCommissionStateError,
  ReferralsMembershipRequiredError,
  ReferralsPayoutValidationError,
  ReferralsProgramInactiveError,
} from '../src/errors.js';

// ============================================================================
// Tests del dominio mod.referrals con un MockPrisma in-memory (sin BD ni red),
// mismo patrón que membership.service.test.ts. Cubren: códigos (idempotencia,
// gates), clics (dedupe), atribución (idempotencia, anti-fraude, first-touch),
// devengo (redondeo, ámbitos, invoice 0 €, idempotencia), máquina de estados
// y liquidación atómica con mínimo.
// ============================================================================

interface Row {
  [key: string]: unknown;
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function uniqueViolation(): Error & { code: string } {
  const err = new Error('Unique constraint failed') as Error & { code: string };
  err.code = 'P2002';
  return err;
}

class MockPrisma {
  configs: Row[] = [];
  codes: Row[] = [];
  clicks: Row[] = [];
  referrals: Row[] = [];
  commissions: Row[] = [];
  payouts: Row[] = [];
  subscriptions: Row[] = [];

  modReferralsConfig = {
    findUnique: async ({ where }: never) =>
      this.configs.find((c) => c['tenantId'] === (where as Row)['tenantId']) ?? null,
    upsert: async ({ where, create, update }: never) => {
      const existing = this.configs.find((c) => c['tenantId'] === (where as Row)['tenantId']);
      if (existing) {
        Object.assign(existing, update as Row);
        return existing;
      }
      const row = { ...(create as Row) };
      this.configs.push(row);
      return row;
    },
  };

  modReferralsCode = {
    findUnique: async ({ where }: never) => {
      const w = where as Row;
      const byUser = w['tenantId_userId'] as Row | undefined;
      if (byUser) {
        return (
          this.codes.find(
            (c) => c['tenantId'] === byUser['tenantId'] && c['userId'] === byUser['userId'],
          ) ?? null
        );
      }
      const byCode = w['tenantId_code'] as Row | undefined;
      if (byCode) {
        return (
          this.codes.find(
            (c) => c['tenantId'] === byCode['tenantId'] && c['code'] === byCode['code'],
          ) ?? null
        );
      }
      return null;
    },
    create: async ({ data }: never) => {
      const d = data as Row;
      if (
        this.codes.some((c) => c['tenantId'] === d['tenantId'] && c['userId'] === d['userId']) ||
        this.codes.some((c) => c['tenantId'] === d['tenantId'] && c['code'] === d['code'])
      ) {
        throw uniqueViolation();
      }
      const row = { id: nextId('code'), createdAt: new Date(), ...d };
      this.codes.push(row);
      return row;
    },
    findMany: async (_args: never) =>
      this.codes.map((c) => ({
        ...c,
        _count: { clicks: this.clicks.filter((k) => k['codeId'] === c['id']).length },
      })),
  };

  modReferralsClick = {
    create: async ({ data }: never) => {
      const d = data as Row;
      if (
        this.clicks.some(
          (k) =>
            k['codeId'] === d['codeId'] && k['day'] === d['day'] && k['ipHash'] === d['ipHash'],
        )
      ) {
        throw uniqueViolation();
      }
      const row = { id: nextId('click'), createdAt: new Date(), ...d };
      this.clicks.push(row);
      return row;
    },
    count: async ({ where }: never) =>
      this.clicks.filter((k) => k['codeId'] === (where as Row)['codeId']).length,
  };

  modReferralsReferral = {
    findUnique: async ({ where }: never) => {
      const w = where as Row;
      if (w['stripeSubscriptionId']) {
        return (
          this.referrals.find((r) => r['stripeSubscriptionId'] === w['stripeSubscriptionId']) ??
          null
        );
      }
      const byUser = w['tenantId_referredUserId'] as Row | undefined;
      if (byUser) {
        return (
          this.referrals.find(
            (r) =>
              r['tenantId'] === byUser['tenantId'] &&
              r['referredUserId'] === byUser['referredUserId'],
          ) ?? null
        );
      }
      return null;
    },
    findFirst: async ({ where }: never) => {
      const w = where as Row;
      return (
        this.referrals.find(
          (r) => r['tenantId'] === w['tenantId'] && r['subscriptionId'] === w['subscriptionId'],
        ) ?? null
      );
    },
    create: async ({ data }: never) => {
      const d = data as Row;
      if (
        this.referrals.some((r) => r['stripeSubscriptionId'] === d['stripeSubscriptionId']) ||
        this.referrals.some(
          (r) => r['tenantId'] === d['tenantId'] && r['referredUserId'] === d['referredUserId'],
        )
      ) {
        throw uniqueViolation();
      }
      const row = { id: nextId('ref'), attributedAt: new Date(), ...d };
      this.referrals.push(row);
      return row;
    },
    count: async ({ where }: never) => {
      const w = where as Row;
      return this.referrals.filter(
        (r) => r['tenantId'] === w['tenantId'] && r['referrerUserId'] === w['referrerUserId'],
      ).length;
    },
    groupBy: async ({ where }: never) => {
      const w = where as Row;
      const grouped = new Map<string, number>();
      for (const r of this.referrals.filter((x) => x['tenantId'] === w['tenantId'])) {
        const key = r['referrerUserId'] as string;
        grouped.set(key, (grouped.get(key) ?? 0) + 1);
      }
      return [...grouped.entries()].map(([referrerUserId, count]) => ({
        referrerUserId,
        _count: count,
      }));
    },
  };

  modReferralsCommission = {
    findUnique: async ({ where }: never) =>
      this.commissions.find((c) => c['stripeInvoiceId'] === (where as Row)['stripeInvoiceId']) ??
      null,
    findFirst: async ({ where }: never) => {
      const w = where as Row;
      return (
        this.commissions.find((c) => c['id'] === w['id'] && c['tenantId'] === w['tenantId']) ?? null
      );
    },
    findMany: async ({ where }: never) => {
      const w = (where ?? {}) as Row;
      return this.commissions.filter((c) => {
        if (w['tenantId'] && c['tenantId'] !== w['tenantId']) return false;
        if (w['status'] && typeof w['status'] === 'string' && c['status'] !== w['status'])
          return false;
        if (w['referrerUserId'] && c['referrerUserId'] !== w['referrerUserId']) return false;
        if (w['referralId'] && c['referralId'] !== w['referralId']) return false;
        const idIn = (w['id'] as Row | undefined)?.['in'] as string[] | undefined;
        if (idIn && !idIn.includes(c['id'] as string)) return false;
        const approveAfter = (w['approveAfter'] as Row | undefined)?.['lte'] as Date | undefined;
        if (approveAfter && (c['approveAfter'] as Date) > approveAfter) return false;
        return true;
      });
    },
    count: async ({ where }: never) => {
      const w = where as Row;
      return this.commissions.filter((c) => c['referralId'] === w['referralId']).length;
    },
    create: async ({ data }: never) => {
      const d = data as Row;
      if (this.commissions.some((c) => c['stripeInvoiceId'] === d['stripeInvoiceId'])) {
        throw uniqueViolation();
      }
      const row = { id: nextId('com'), createdAt: new Date(), updatedAt: new Date(), ...d };
      this.commissions.push(row);
      return row;
    },
    update: async ({ where, data }: never) => {
      const row = this.commissions.find((c) => c['id'] === (where as Row)['id']);
      if (!row) throw new Error('not found');
      Object.assign(row, data as Row);
      return row;
    },
    updateMany: async ({ where, data }: never) => {
      const w = where as Row;
      const idIn = (w['id'] as Row | undefined)?.['in'] as string[] | undefined;
      const targets = this.commissions.filter((c) => {
        if (idIn && !idIn.includes(c['id'] as string)) return false;
        if (!idIn && w['id'] && c['id'] !== w['id']) return false;
        if (w['tenantId'] && c['tenantId'] !== w['tenantId']) return false;
        const status = w['status'];
        if (status) {
          const statusIn =
            typeof status === 'object' ? ((status as Row)['in'] as string[]) : undefined;
          if (statusIn ? !statusIn.includes(c['status'] as string) : c['status'] !== status)
            return false;
        }
        return true;
      });
      for (const t of targets) Object.assign(t, data as Row);
      return { count: targets.length };
    },
    groupBy: async ({ by, where }: never) => {
      const w = (where ?? {}) as Row;
      const fields = by as string[];
      const rows = this.commissions.filter((c) => {
        if (w['tenantId'] && c['tenantId'] !== w['tenantId']) return false;
        if (w['referrerUserId'] && c['referrerUserId'] !== w['referrerUserId']) return false;
        return true;
      });
      const grouped = new Map<string, { rows: Row[]; keys: Row }>();
      for (const r of rows) {
        const keyObj: Row = {};
        for (const f of fields) keyObj[f] = r[f];
        const key = JSON.stringify(keyObj);
        const entry = grouped.get(key) ?? { rows: [], keys: keyObj };
        entry.rows.push(r);
        grouped.set(key, entry);
      }
      return [...grouped.values()].map((g) => ({
        ...g.keys,
        _sum: {
          amountCents: g.rows.reduce((sum, r) => sum + (r['amountCents'] as number), 0),
        },
        _count: g.rows.length,
      }));
    },
  };

  modReferralsPayout = {
    create: async ({ data }: never) => {
      const row = { id: nextId('payout'), createdAt: new Date(), ...(data as Row) };
      this.payouts.push(row);
      return row;
    },
    findMany: async ({ where }: never) => {
      const w = where as Row;
      return this.payouts.filter(
        (p) => p['tenantId'] === w['tenantId'] && p['referrerUserId'] === w['referrerUserId'],
      );
    },
  };

  modSubscriptionsSubscription = {
    findFirst: async ({ where }: never) => {
      const w = where as Row;
      const statuses = ((w['status'] as Row)?.['in'] as string[]) ?? [];
      return (
        this.subscriptions.find(
          (s) =>
            s['tenantId'] === w['tenantId'] &&
            s['userId'] === w['userId'] &&
            s['planId'] != null &&
            statuses.includes(s['status'] as string),
        ) ?? null
      );
    },
  };

  $transaction = async <T>(fn: (tx: this) => Promise<T>): Promise<T> => {
    // El mock no simula rollback: los tests de atomicidad validan el throw.
    return fn(this);
  };
}

interface PublishedEvent {
  tenantId: string;
  actorId: string | null;
  name: string;
  payload: Record<string, unknown>;
}

function buildPublisher(): { publisher: ReferralsEventPublisher; events: PublishedEvent[] } {
  const events: PublishedEvent[] = [];
  return {
    events,
    publisher: {
      publish: async (tenantId, actorId, name, payload) => {
        events.push({ tenantId, actorId, name, payload });
      },
    },
  };
}

const TENANT = 'tenant-1';
const emails = new Map<string, string>();

function build(overrides: { config?: Row } = {}) {
  const prisma = new MockPrisma();
  if (overrides.config !== null) {
    prisma.configs.push({
      tenantId: TENANT,
      active: true,
      commissionBps: 3000,
      scope: 'RECURRING',
      recurringMonths: null,
      attributionWindowDays: 30,
      guaranteeDays: 14,
      minPayoutCents: 0,
      requireActiveMembership: false,
      memberCopy: null,
      ...(overrides.config ?? {}),
    });
  }
  const { publisher, events } = buildPublisher();
  const service = new ReferralsService(
    prisma as never,
    publisher,
    async (_tenantId, userId) => emails.get(userId) ?? null,
  );
  return { prisma, service, events };
}

/** Atajo: atribución válida referrer-1 → buyer-1 con sub-1. */
async function seedAttribution(prisma: MockPrisma, service: ReferralsService) {
  const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
  const result = await service.attribute({
    tenantId: TENANT,
    referralCode: code,
    referredUserId: 'buyer-1',
    stripeSubscriptionId: 'sub_stripe_1',
    subscriptionId: 'sub-local-1',
    planId: 'plan-1',
  });
  if (!result.attributed) throw new Error(`seed attribution failed: ${result.reason}`);
  return { code, referralId: result.referralId };
}

beforeEach(() => {
  idSeq = 0;
  emails.clear();
  emails.set('referrer-1', 'referrer@example.test');
  emails.set('buyer-1', 'buyer@example.test');
});

describe('getOrCreateCode', () => {
  it('crea un código y es idempotente por usuario', async () => {
    const { service } = build();
    const first = await service.getOrCreateCode(TENANT, 'referrer-1');
    const second = await service.getOrCreateCode(TENANT, 'referrer-1');
    expect(first.code).toMatch(/^[a-z2-9]{8}$/);
    expect(second.code).toBe(first.code);
  });

  it('lanza si el programa está inactivo', async () => {
    const { service } = build({ config: { active: false } });
    await expect(service.getOrCreateCode(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsProgramInactiveError,
    );
  });

  it('con requireActiveMembership exige membresía viva del referidor', async () => {
    const { prisma, service } = build({ config: { requireActiveMembership: true } });
    await expect(service.getOrCreateCode(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsMembershipRequiredError,
    );
    prisma.subscriptions.push({
      tenantId: TENANT,
      userId: 'referrer-1',
      planId: 'plan-1',
      status: 'TRIALING',
    });
    await expect(service.getOrCreateCode(TENANT, 'referrer-1')).resolves.toHaveProperty('code');
  });
});

describe('registerClick', () => {
  it('registra un clic y dedupea (código, día, ipHash)', async () => {
    const { service } = build();
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    expect(await service.registerClick(TENANT, code, 'ip-a')).toBe(true);
    expect(await service.registerClick(TENANT, code, 'ip-a')).toBe(false);
    expect(await service.registerClick(TENANT, code, 'ip-b')).toBe(true);
    expect(await service.registerClick(TENANT, code, 'ip-a', '2099-01-01')).toBe(true);
  });

  it('código inexistente o programa inactivo → false sin lanzar', async () => {
    const { service } = build();
    expect(await service.registerClick(TENANT, 'nope', 'ip-a')).toBe(false);
    const inactive = build({ config: { active: false } });
    expect(await inactive.service.registerClick(TENANT, 'whatever', 'ip-a')).toBe(false);
  });
});

describe('attribute', () => {
  it('atribuye y emite referrals.referral.attributed', async () => {
    const { prisma, service, events } = build();
    const { referralId } = await seedAttribution(prisma, service);
    expect(prisma.referrals).toHaveLength(1);
    const attributed = events.find((e) => e.name === 'referrals.referral.attributed');
    expect(attributed?.payload['referralId']).toBe(referralId);
    expect(attributed?.payload['referrerUserId']).toBe('referrer-1');
  });

  it('es idempotente por suscripción de Stripe (reintentos del webhook)', async () => {
    const { prisma, service, events } = build();
    const { code, referralId } = await seedAttribution(prisma, service);
    const again = await service.attribute({
      tenantId: TENANT,
      referralCode: code,
      referredUserId: 'buyer-1',
      stripeSubscriptionId: 'sub_stripe_1',
      subscriptionId: 'sub-local-1',
    });
    expect(again).toMatchObject({ attributed: true, referralId, alreadyExisted: true });
    expect(events.filter((e) => e.name === 'referrals.referral.attributed')).toHaveLength(1);
  });

  it('bloquea el auto-referido por userId y por email normalizado', async () => {
    const { service } = build();
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    const byId = await service.attribute({
      tenantId: TENANT,
      referralCode: code,
      referredUserId: 'referrer-1',
      stripeSubscriptionId: 'sub_self',
      subscriptionId: 'sub-local-self',
    });
    expect(byId).toMatchObject({ attributed: false, reason: 'self_referral' });

    emails.set('alter-ego', '  Referrer@Example.test ');
    const byEmail = await service.attribute({
      tenantId: TENANT,
      referralCode: code,
      referredUserId: 'alter-ego',
      stripeSubscriptionId: 'sub_alter',
      subscriptionId: 'sub-local-alter',
    });
    expect(byEmail).toMatchObject({ attributed: false, reason: 'self_referral' });
  });

  it('first-touch: un referido no se re-atribuye a otro referidor', async () => {
    const { prisma, service } = build();
    await seedAttribution(prisma, service);
    emails.set('referrer-2', 'r2@example.test');
    const { code: code2 } = await service.getOrCreateCode(TENANT, 'referrer-2');
    const again = await service.attribute({
      tenantId: TENANT,
      referralCode: code2,
      referredUserId: 'buyer-1',
      stripeSubscriptionId: 'sub_stripe_2',
      subscriptionId: 'sub-local-2',
    });
    expect(again).toMatchObject({ attributed: false, reason: 'already_attributed' });
  });

  it('código inexistente o programa inactivo → sin atribución y sin lanzar', async () => {
    const { service } = build();
    const missing = await service.attribute({
      tenantId: TENANT,
      referralCode: 'nope',
      referredUserId: 'buyer-1',
      stripeSubscriptionId: 'sub_x',
      subscriptionId: 'sub-local-x',
    });
    expect(missing).toMatchObject({ attributed: false, reason: 'code_not_found' });

    const inactive = build({ config: { active: false } });
    const off = await inactive.service.attribute({
      tenantId: TENANT,
      referralCode: 'whatever',
      referredUserId: 'buyer-1',
      stripeSubscriptionId: 'sub_y',
      subscriptionId: 'sub-local-y',
    });
    expect(off).toMatchObject({ attributed: false, reason: 'program_inactive' });
  });
});

describe('accrueCommission', () => {
  it('devenga PENDING con redondeo correcto y emite el evento', async () => {
    const { prisma, service, events } = build();
    await seedAttribution(prisma, service);
    const result = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_1',
      amountCents: 3990,
      currency: 'eur',
    });
    // 3990 × 30 % = 1197
    expect(result).toMatchObject({ accrued: true, amountCents: 1197, alreadyExisted: false });
    const commission = prisma.commissions[0]!;
    expect(commission['status']).toBe('PENDING');
    expect(commission['commissionBps']).toBe(3000);
    const expectedApprove = Date.now() + 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs((commission['approveAfter'] as Date).getTime() - expectedApprove)).toBeLessThan(
      5_000,
    );
    expect(events.some((e) => e.name === 'referrals.commission.created')).toBe(true);
  });

  it('invoice a 0 € (trial/cupón) y sub sin atribución no devengan', async () => {
    const { prisma, service } = build();
    await seedAttribution(prisma, service);
    const zero = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_zero',
      amountCents: 0,
      currency: 'eur',
    });
    expect(zero).toMatchObject({ accrued: false, reason: 'zero_amount' });
    const unattributed = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-otro',
      stripeInvoiceId: 'in_2',
      amountCents: 1000,
      currency: 'eur',
    });
    expect(unattributed).toMatchObject({ accrued: false, reason: 'not_attributed' });
  });

  it('es idempotente por invoice de Stripe', async () => {
    const { prisma, service, events } = build();
    await seedAttribution(prisma, service);
    const first = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_1',
      amountCents: 1000,
      currency: 'eur',
    });
    const second = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_1',
      amountCents: 1000,
      currency: 'eur',
    });
    expect(second).toMatchObject({
      accrued: true,
      alreadyExisted: true,
      commissionId: (first as { commissionId: string }).commissionId,
    });
    expect(prisma.commissions).toHaveLength(1);
    expect(events.filter((e) => e.name === 'referrals.commission.created')).toHaveLength(1);
  });

  it('scope FIRST_PAYMENT: solo el primer cobro devenga', async () => {
    const { prisma, service } = build({ config: { scope: 'FIRST_PAYMENT' } });
    await seedAttribution(prisma, service);
    const first = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_1',
      amountCents: 1000,
      currency: 'eur',
    });
    expect(first).toMatchObject({ accrued: true });
    const second = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_2',
      amountCents: 1000,
      currency: 'eur',
    });
    expect(second).toMatchObject({ accrued: false, reason: 'out_of_scope' });
  });

  it('scope RECURRING con recurringMonths: fuera de ventana no devenga', async () => {
    const { prisma, service } = build({ config: { recurringMonths: 12 } });
    await seedAttribution(prisma, service);
    // Atribución hace 13 meses → fuera de la ventana de 12.
    const thirteenMonthsAgo = new Date();
    thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);
    prisma.referrals[0]!['attributedAt'] = thirteenMonthsAgo;
    const result = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_old',
      amountCents: 1000,
      currency: 'eur',
    });
    expect(result).toMatchObject({ accrued: false, reason: 'out_of_scope' });
  });

  it('requireActiveMembership: sin membresía viva del referidor no devenga', async () => {
    const { prisma, service } = build();
    await seedAttribution(prisma, service);
    // Activamos el requisito DESPUÉS de la atribución (el gate es al devengar).
    prisma.configs[0]!['requireActiveMembership'] = true;
    const blocked = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_1',
      amountCents: 1000,
      currency: 'eur',
    });
    expect(blocked).toMatchObject({ accrued: false, reason: 'referrer_membership_inactive' });
    prisma.subscriptions.push({
      tenantId: TENANT,
      userId: 'referrer-1',
      planId: 'plan-1',
      status: 'ACTIVE',
    });
    const ok = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_2',
      amountCents: 1000,
      currency: 'eur',
    });
    expect(ok).toMatchObject({ accrued: true });
  });
});

describe('ciclo de vida de comisiones', () => {
  async function seedCommission(prisma: MockPrisma, service: ReferralsService) {
    await seedAttribution(prisma, service);
    const result = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_1',
      amountCents: 1000,
      currency: 'eur',
    });
    return (result as { commissionId: string }).commissionId;
  }

  it('approveDueCommissions aprueba solo las vencidas y emite eventos', async () => {
    const { prisma, service, events } = build();
    const commissionId = await seedCommission(prisma, service);
    expect(await service.approveDueCommissions()).toBe(0); // garantía aún viva
    const future = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    expect(await service.approveDueCommissions(future)).toBe(1);
    expect(prisma.commissions[0]!['status']).toBe('APPROVED');
    expect(
      events.filter((e) => e.name === 'referrals.commission.approved').map((e) => e.payload),
    ).toEqual([{ commissionId, referrerUserId: 'referrer-1' }]);
    // Re-ejecutar no re-aprueba.
    expect(await service.approveDueCommissions(future)).toBe(0);
  });

  it('revokeCommission exige motivo y respeta la máquina de estados', async () => {
    const { prisma, service } = build();
    const commissionId = await seedCommission(prisma, service);
    await expect(
      service.revokeCommission(TENANT, commissionId, '  ', 'admin-1'),
    ).rejects.toBeInstanceOf(ReferralsCommissionStateError);
    await service.revokeCommission(TENANT, commissionId, 'Reembolso del comprador', 'admin-1');
    expect(prisma.commissions[0]!['status']).toBe('REVOKED');
    expect(prisma.commissions[0]!['revokeReason']).toBe('Reembolso del comprador');
    // Una revocada no se puede volver a revocar.
    await expect(
      service.revokeCommission(TENANT, commissionId, 'otra vez', 'admin-1'),
    ).rejects.toBeInstanceOf(ReferralsCommissionStateError);
  });

  it('approveCommissionNow solo acepta PENDING', async () => {
    const { prisma, service } = build();
    const commissionId = await seedCommission(prisma, service);
    await service.approveCommissionNow(TENANT, commissionId);
    expect(prisma.commissions[0]!['status']).toBe('APPROVED');
    await expect(service.approveCommissionNow(TENANT, commissionId)).rejects.toBeInstanceOf(
      ReferralsCommissionStateError,
    );
  });
});

describe('recordPayout', () => {
  async function seedApproved(prisma: MockPrisma, service: ReferralsService, invoices: string[]) {
    await seedAttribution(prisma, service);
    const ids: string[] = [];
    for (const inv of invoices) {
      const r = await service.accrueCommission({
        tenantId: TENANT,
        subscriptionId: 'sub-local-1',
        stripeInvoiceId: inv,
        amountCents: 3000,
        currency: 'eur',
      });
      ids.push((r as { commissionId: string }).commissionId);
    }
    await service.approveDueCommissions(new Date(Date.now() + 15 * 24 * 60 * 60 * 1000));
    return ids;
  }

  it('marca el lote PAID, crea el payout y emite el evento', async () => {
    const { prisma, service, events } = build();
    const ids = await seedApproved(prisma, service, ['in_1', 'in_2']);
    const payout = await service.recordPayout(TENANT, {
      referrerUserId: 'referrer-1',
      commissionIds: ids,
      externalReference: 'Transferencia SEPA 2026-07-24',
      createdByUserId: 'admin-1',
    });
    // 2 comisiones × (3000 × 30 %) = 1800
    expect(payout.totalCents).toBe(1800);
    expect(prisma.commissions.every((c) => c['status'] === 'PAID')).toBe(true);
    expect(prisma.commissions.every((c) => c['payoutId'] === payout.payoutId)).toBe(true);
    expect(events.some((e) => e.name === 'referrals.payout.recorded')).toBe(true);
  });

  it('respeta el mínimo de liquidación configurado', async () => {
    const { prisma, service } = build({ config: { minPayoutCents: 5000 } });
    const ids = await seedApproved(prisma, service, ['in_1']); // 900 cts < 5000
    await expect(
      service.recordPayout(TENANT, {
        referrerUserId: 'referrer-1',
        commissionIds: ids,
        externalReference: 'ref',
        createdByUserId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ReferralsPayoutValidationError);
  });

  it('rechaza lotes con comisiones no APPROVED, de otro referidor o sin referencia', async () => {
    const { prisma, service } = build();
    await seedAttribution(prisma, service);
    const pending = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_1',
      amountCents: 3000,
      currency: 'eur',
    });
    const pendingId = (pending as { commissionId: string }).commissionId;
    await expect(
      service.recordPayout(TENANT, {
        referrerUserId: 'referrer-1',
        commissionIds: [pendingId],
        externalReference: 'ref',
        createdByUserId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ReferralsPayoutValidationError);
    await expect(
      service.recordPayout(TENANT, {
        referrerUserId: 'otro',
        commissionIds: [pendingId],
        externalReference: 'ref',
        createdByUserId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ReferralsPayoutValidationError);
    await expect(
      service.recordPayout(TENANT, {
        referrerUserId: 'referrer-1',
        commissionIds: [pendingId],
        externalReference: '   ',
        createdByUserId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ReferralsPayoutValidationError);
  });
});

describe('revokeCommissionByInvoice (reembolso)', () => {
  async function seedPending(prisma: MockPrisma, service: ReferralsService) {
    await seedAttribution(prisma, service);
    const r = await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_refund',
      amountCents: 990,
      currency: 'eur',
    });
    return (r as { commissionId: string }).commissionId;
  }

  it('revoca una PENDING por reembolso y emite el evento', async () => {
    const { prisma, service, events } = build();
    const commissionId = await seedPending(prisma, service);
    const result = await service.revokeCommissionByInvoice(
      TENANT,
      'in_refund',
      'Reembolso del cobro en Stripe',
    );
    expect(result).toMatchObject({ revoked: true, commissionId });
    expect(prisma.commissions[0]!['status']).toBe('REVOKED');
    expect(prisma.commissions[0]!['revokeReason']).toBe('Reembolso del cobro en Stripe');
    expect(events.some((e) => e.name === 'referrals.commission.revoked')).toBe(true);
  });

  it('revoca también una APPROVED, pero nunca una PAID (clawback manual)', async () => {
    const { prisma, service } = build();
    const commissionId = await seedPending(prisma, service);
    await service.approveCommissionNow(TENANT, commissionId);
    const approved = await service.revokeCommissionByInvoice(TENANT, 'in_refund', 'refund');
    expect(approved).toMatchObject({ revoked: true });

    // Reconstruimos con una comisión PAID: el reembolso no la toca.
    const paid = build();
    const paidId = await seedPending(paid.prisma, paid.service);
    await paid.service.approveCommissionNow(TENANT, paidId);
    await paid.service.recordPayout(TENANT, {
      referrerUserId: 'referrer-1',
      commissionIds: [paidId],
      externalReference: 'transf',
      createdByUserId: 'admin-1',
    });
    const blocked = await paid.service.revokeCommissionByInvoice(TENANT, 'in_refund', 'refund');
    expect(blocked).toMatchObject({ revoked: false, reason: 'already_paid' });
    expect(paid.prisma.commissions[0]!['status']).toBe('PAID');
  });

  it('invoice desconocida o de otro tenant → not_found; doble reembolso → already_revoked', async () => {
    const { prisma, service } = build();
    await seedPending(prisma, service);
    expect(await service.revokeCommissionByInvoice(TENANT, 'in_nope', 'r')).toMatchObject({
      revoked: false,
      reason: 'not_found',
    });
    expect(await service.revokeCommissionByInvoice('otro-tenant', 'in_refund', 'r')).toMatchObject({
      revoked: false,
      reason: 'not_found',
    });
    await service.revokeCommissionByInvoice(TENANT, 'in_refund', 'r');
    expect(await service.revokeCommissionByInvoice(TENANT, 'in_refund', 'r')).toMatchObject({
      revoked: false,
      reason: 'already_revoked',
    });
  });
});

describe('memberStats', () => {
  it('agrega clics, altas y totales por estado con datos reales', async () => {
    const { prisma, service } = build();
    const { code } = await seedAttribution(prisma, service);
    await service.registerClick(TENANT, code, 'ip-a');
    await service.registerClick(TENANT, code, 'ip-b');
    await service.accrueCommission({
      tenantId: TENANT,
      subscriptionId: 'sub-local-1',
      stripeInvoiceId: 'in_1',
      amountCents: 3990,
      currency: 'eur',
    });
    const stats = await service.memberStats(TENANT, 'referrer-1');
    expect(stats.code).toBe(code);
    expect(stats.clicks).toBe(2);
    expect(stats.referrals).toBe(1);
    expect(stats.totals.pendingCents).toBe(1197);
    expect(stats.totals.paidCents).toBe(0);
    expect(stats.commissions).toHaveLength(1);
  });
});

describe('utcDay', () => {
  it('devuelve YYYY-MM-DD en UTC', () => {
    expect(utcDay(new Date('2026-07-24T23:59:59Z'))).toBe('2026-07-24');
  });
});
