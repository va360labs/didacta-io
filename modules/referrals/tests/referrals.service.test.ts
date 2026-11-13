import { beforeEach, describe, expect, it } from 'vitest';
import {
  REFERRAL_TERMS_VERSION,
  ReferralsService,
  creditIdempotencyKey,
  purchaseInvoiceRef,
  utcDay,
  type ReferralsCreditPort,
  type ReferralsEventPublisher,
} from '../src/referrals.service.js';
import {
  ReferralsCommissionStateError,
  ReferralsCreditDisabledError,
  ReferralsCreditFailedError,
  ReferralsCreditNothingError,
  ReferralsCreditUnavailableError,
  ReferralsMembershipRequiredError,
  ReferralsPayoutValidationError,
  ReferralsProgramInactiveError,
  ReferralsTermsRequiredError,
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
  members: Row[] = [];
  /**
   * Arnés: los alumnos de estos tests ya aceptaron las condiciones (mayor de
   * 18) salvo que el test lo apague para probar la casilla.
   */
  autoAcceptTerms = true;

  modReferralsMember = {
    findUnique: async ({ where }: never) => {
      const key = (where as Row)['tenantId_userId'] as Row;
      const row = this.members.find(
        (m) => m['tenantId'] === key['tenantId'] && m['userId'] === key['userId'],
      );
      if (row) return row;
      return this.autoAcceptTerms
        ? { termsVersion: REFERRAL_TERMS_VERSION, termsAcceptedAt: new Date('2026-11-13') }
        : null;
    },
    upsert: async ({ where, create, update }: never) => {
      const key = (where as Row)['tenantId_userId'] as Row;
      const row = this.members.find(
        (m) => m['tenantId'] === key['tenantId'] && m['userId'] === key['userId'],
      );
      if (row) return Object.assign(row, update as Row);
      const created = { ...(create as Row) };
      this.members.push(created);
      return created;
    },
  };

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
        // Como Postgres: el índice único admite varios NULL (referidos de compra).
        (d['stripeSubscriptionId'] != null &&
          this.referrals.some((r) => r['stripeSubscriptionId'] === d['stripeSubscriptionId'])) ||
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
        if ('payoutId' in w && w['payoutId'] === null && c['payoutId'] != null) return false;
        if (w['currency'] && c['currency'] !== w['currency']) return false;
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
        if ('payoutId' in w && w['payoutId'] === null && c['payoutId'] != null) return false;
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
      const d = data as Row;
      // Como el índice parcial: una CREDIT PENDING por alumno y aula.
      if (
        d['method'] === 'CREDIT' &&
        d['status'] === 'PENDING' &&
        this.payouts.some(
          (p) =>
            p['tenantId'] === d['tenantId'] &&
            p['referrerUserId'] === d['referrerUserId'] &&
            p['method'] === 'CREDIT' &&
            p['status'] === 'PENDING',
        )
      ) {
        throw uniqueViolation();
      }
      const row = {
        id: nextId('payout'),
        createdAt: new Date(),
        method: 'CASH',
        status: 'DONE',
        stripeCustomerId: null,
        ...d,
      };
      this.payouts.push(row);
      return row;
    },
    findFirst: async ({ where }: never) => {
      const w = where as Row;
      const row = this.payouts.find((p) => Object.entries(w).every(([k, v]) => p[k] === v)) ?? null;
      if (!row) return null;
      return {
        ...row,
        commissions: this.commissions
          .filter((c) => c['payoutId'] === row['id'])
          .map((c) => ({ id: c['id'] })),
      };
    },
    updateMany: async ({ where, data }: never) => {
      const w = where as Row;
      const targets = this.payouts.filter((p) => Object.entries(w).every(([k, v]) => p[k] === v));
      for (const t of targets) Object.assign(t, data as Row);
      return { count: targets.length };
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
      const customerPrefix = (w['stripeCustomerId'] as Row | undefined)?.['startsWith'] as
        | string
        | undefined;
      return (
        this.subscriptions.find(
          (s) =>
            s['tenantId'] === w['tenantId'] &&
            s['userId'] === w['userId'] &&
            s['planId'] != null &&
            statuses.includes(s['status'] as string) &&
            (!customerPrefix || String(s['stripeCustomerId'] ?? '').startsWith(customerPrefix)),
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

function build(overrides: { config?: Row; creditPort?: ReferralsCreditPort } = {}) {
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
      allowCreditRedemption: true,
      ...(overrides.config ?? {}),
    });
  }
  const { publisher, events } = buildPublisher();
  const service = new ReferralsService(
    prisma as never,
    publisher,
    async (_tenantId, userId) => emails.get(userId) ?? null,
    overrides.creditPort ?? null,
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

describe('condiciones del programa (mayor de 18)', () => {
  it('sin aceptar no hay enlace; con la casilla y la versión vigente, sí', async () => {
    const { prisma, service } = build();
    prisma.autoAcceptTerms = false;
    await expect(service.getOrCreateCode(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsTermsRequiredError,
    );
    const now = new Date('2026-11-13T10:00:00.000Z');
    const accepted = await service.acceptTerms(
      TENANT,
      'referrer-1',
      { version: REFERRAL_TERMS_VERSION, adult: true },
      now,
    );
    expect(accepted).toEqual({ version: REFERRAL_TERMS_VERSION, acceptedAt: now });
    expect(prisma.members[0]).toMatchObject({
      tenantId: TENANT,
      userId: 'referrer-1',
      termsVersion: REFERRAL_TERMS_VERSION,
      termsAcceptedAt: now,
    });
    await expect(service.getOrCreateCode(TENANT, 'referrer-1')).resolves.toHaveProperty('code');
    // Idempotente: aceptar otra vez no mueve la fecha de la primera aceptación.
    const again = await service.acceptTerms(TENANT, 'referrer-1', {
      version: REFERRAL_TERMS_VERSION,
      adult: true,
    });
    expect(again.acceptedAt).toEqual(now);
  });

  it('sin declarar la mayoría de edad, o con una versión que no es la vigente, no acepta', async () => {
    const { prisma, service } = build();
    prisma.autoAcceptTerms = false;
    await expect(
      service.acceptTerms(TENANT, 'referrer-1', { version: REFERRAL_TERMS_VERSION, adult: false }),
    ).rejects.toBeInstanceOf(ReferralsTermsRequiredError);
    await expect(
      service.acceptTerms(TENANT, 'referrer-1', { version: '2020-01-01', adult: true }),
    ).rejects.toBeInstanceOf(ReferralsTermsRequiredError);
    expect(prisma.members).toHaveLength(0);
  });

  it('una versión vieja aceptada no da enlace nuevo pero sí sigue atribuyendo', async () => {
    const { prisma, service } = build();
    prisma.autoAcceptTerms = false;
    prisma.members.push({
      tenantId: TENANT,
      userId: 'referrer-1',
      termsVersion: '2026-01-01',
      termsAcceptedAt: new Date('2026-01-01'),
    });
    const status = await service.termsStatus(TENANT, 'referrer-1');
    expect(status).toMatchObject({ accepted: false, acceptedVersion: '2026-01-01' });
    await expect(service.getOrCreateCode(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsTermsRequiredError,
    );
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

describe('recordPurchase (compra suelta con enlace)', () => {
  async function purchase(
    service: ReferralsService,
    code: string,
    over: Partial<{ buyer: string; orderId: string; amountCents: number }> = {},
  ) {
    return service.recordPurchase({
      tenantId: TENANT,
      referralCode: code,
      buyerUserId: over.buyer ?? 'buyer-1',
      orderId: over.orderId ?? 'order-1',
      amountCents: over.amountCents ?? 4900,
      currency: 'eur',
    });
  }

  it('el enlace de quien no aceptó las condiciones no atribuye ni devenga', async () => {
    const { prisma, service } = build();
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    // Enlace viejo de alguien que nunca marcó la casilla.
    prisma.autoAcceptTerms = false;
    expect(await purchase(service, code)).toEqual({
      accrued: false,
      reason: 'terms_not_accepted',
    });
    expect(prisma.commissions).toHaveLength(0);
    expect(prisma.referrals).toHaveLength(0);
  });

  it('crea el referido de la orden y devenga PENDING con el mismo % y garantía', async () => {
    const { prisma, service, events } = build();
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    const result = await purchase(service, code);
    // 4900 × 30 % = 1470
    expect(result).toMatchObject({
      accrued: true,
      amountCents: 1470,
      referrerUserId: 'referrer-1',
      alreadyExisted: false,
    });
    expect(prisma.referrals[0]).toMatchObject({
      referredUserId: 'buyer-1',
      orderId: 'order-1',
      code,
    });
    expect(prisma.referrals[0]!['subscriptionId']).toBeUndefined();
    const commission = prisma.commissions[0]!;
    expect(commission).toMatchObject({
      stripeInvoiceId: 'order:order-1',
      baseAmountCents: 4900,
      status: 'PENDING',
      commissionBps: 3000,
    });
    const expectedApprove = Date.now() + 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs((commission['approveAfter'] as Date).getTime() - expectedApprove)).toBeLessThan(
      5_000,
    );
    expect(events.map((e) => e.name)).toEqual([
      'referrals.referral.attributed',
      'referrals.commission.created',
    ]);
    expect(events[0]!.payload['orderId']).toBe('order-1');
  });

  it('es idempotente por orden (webhook reentregado)', async () => {
    const { prisma, service } = build();
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    await purchase(service, code);
    const again = await purchase(service, code);
    expect(again).toMatchObject({ accrued: true, alreadyExisted: true });
    expect(prisma.referrals).toHaveLength(1);
    expect(prisma.commissions).toHaveLength(1);
  });

  it('dos compras de dos personas con el mismo enlace: dos referidos y dos comisiones', async () => {
    const { prisma, service } = build();
    emails.set('buyer-2', 'b2@example.test');
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    await purchase(service, code);
    const second = await purchase(service, code, { buyer: 'buyer-2', orderId: 'order-2' });
    expect(second).toMatchObject({ accrued: true });
    expect(prisma.referrals).toHaveLength(2);
    expect(prisma.commissions).toHaveLength(2);
  });

  it('bloquea el autorreferido por usuario y por email', async () => {
    const { prisma, service } = build();
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    expect(await purchase(service, code, { buyer: 'referrer-1' })).toMatchObject({
      accrued: false,
      reason: 'self_referral',
    });
    emails.set('alter-ego', 'REFERRER@example.test');
    expect(await purchase(service, code, { buyer: 'alter-ego' })).toMatchObject({
      accrued: false,
      reason: 'self_referral',
    });
    expect(prisma.referrals).toHaveLength(0);
    expect(prisma.commissions).toHaveLength(0);
  });

  it('first-touch: si ya era referido por la membresía, la comisión va a su referidor', async () => {
    const { prisma, service } = build();
    await seedAttribution(prisma, service);
    emails.set('referrer-2', 'r2@example.test');
    const { code: code2 } = await service.getOrCreateCode(TENANT, 'referrer-2');
    const result = await purchase(service, code2);
    expect(result).toMatchObject({ accrued: true, referrerUserId: 'referrer-1' });
    expect(prisma.referrals).toHaveLength(1);
    expect(prisma.commissions[0]!['referrerUserId']).toBe('referrer-1');
  });

  it('programa inactivo, código ajeno o importe 0 → sin comisión y sin lanzar', async () => {
    const { service } = build();
    expect(await purchase(service, 'nope')).toMatchObject({
      accrued: false,
      reason: 'code_not_found',
    });
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    expect(await purchase(service, code, { amountCents: 0 })).toMatchObject({
      accrued: false,
      reason: 'zero_amount',
    });
    const inactive = build({ config: { active: false } });
    expect(await purchase(inactive.service, code)).toMatchObject({
      accrued: false,
      reason: 'program_inactive',
    });
  });

  it('scope FIRST_PAYMENT: solo la primera compra del referido devenga', async () => {
    const { service } = build({ config: { scope: 'FIRST_PAYMENT' } });
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    await purchase(service, code);
    expect(await purchase(service, code, { orderId: 'order-2' })).toMatchObject({
      accrued: false,
      reason: 'out_of_scope',
    });
  });

  it('el reembolso de la orden anula la comisión', async () => {
    const { prisma, service } = build();
    const { code } = await service.getOrCreateCode(TENANT, 'referrer-1');
    await purchase(service, code);
    const revoked = await service.revokeCommissionByInvoice(
      TENANT,
      purchaseInvoiceRef('order-1'),
      'Reembolso de la compra',
    );
    expect(revoked).toMatchObject({ revoked: true });
    expect(prisma.commissions[0]!['status']).toBe('REVOKED');
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

  // ---- Split F3: sweep global (sancionado) + procesado por tenant ----

  it('findTenantsWithDueCommissions devuelve tenants únicos con comisiones vencidas', async () => {
    const { prisma, service } = build();
    await seedCommission(prisma, service); // tenant-1, PENDING
    // Comisión de OTRO tenant, también vencida (seed directo en el mock).
    prisma.commissions.push({
      id: 'com-otro',
      tenantId: 'tenant-2',
      referralId: 'ref-otro',
      referrerUserId: 'referrer-2',
      stripeInvoiceId: 'in_otro',
      amountCents: 500,
      currency: 'eur',
      status: 'PENDING',
      approveAfter: new Date(Date.now() - 1000),
    });
    const future = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    expect((await service.findTenantsWithDueCommissions(future)).sort()).toEqual([
      TENANT,
      'tenant-2',
    ]);
    // Sin garantía vencida no hay tenants.
    expect(await service.findTenantsWithDueCommissions(new Date(0))).toEqual([]);
  });

  it('approveDueCommissionsForTenant solo aprueba las de ESE tenant', async () => {
    const { prisma, service, events } = build();
    const commissionId = await seedCommission(prisma, service); // tenant-1
    prisma.commissions.push({
      id: 'com-otro',
      tenantId: 'tenant-2',
      referralId: 'ref-otro',
      referrerUserId: 'referrer-2',
      stripeInvoiceId: 'in_otro',
      amountCents: 500,
      currency: 'eur',
      status: 'PENDING',
      approveAfter: new Date(Date.now() - 1000),
    });
    const future = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

    expect(await service.approveDueCommissionsForTenant(TENANT, future)).toBe(1);

    expect(prisma.commissions.find((c) => c['id'] === commissionId)!['status']).toBe('APPROVED');
    // La comisión del otro tenant queda intacta.
    expect(prisma.commissions.find((c) => c['id'] === 'com-otro')!['status']).toBe('PENDING');
    expect(
      events.filter((e) => e.name === 'referrals.commission.approved').map((e) => e.tenantId),
    ).toEqual([TENANT]);
    // Re-ejecutar no re-aprueba (idempotente).
    expect(await service.approveDueCommissionsForTenant(TENANT, future)).toBe(0);
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

// ============================================================================
// Descuento en la cuota (saldo de cliente de Stripe)
// ============================================================================

/** Doble del saldo de cliente: idempotente por clave, como Stripe. */
function fakeCreditPort(opts: { balanceCents?: number; failTimes?: number } = {}) {
  const balances = new Map<string, number>();
  const byKey = new Map<string, { id: string; amountCents: number }>();
  const calls: Array<{ tenantId: string; customerId: string; amountCents: number; key: string }> =
    [];
  let failures = opts.failTimes ?? 0;
  let seq = 0;
  const port: ReferralsCreditPort = {
    retrieveBalance: async (_tenantId, customerId) => ({
      balanceCents: balances.get(customerId) ?? opts.balanceCents ?? 0,
      currency: 'eur',
    }),
    credit: async (tenantId, p) => {
      calls.push({
        tenantId,
        customerId: p.customerId,
        amountCents: p.amountCents,
        key: p.idempotencyKey,
      });
      if (failures > 0) {
        failures -= 1;
        throw new Error('stripe 500');
      }
      const done = byKey.get(p.idempotencyKey);
      if (done) return { id: done.id };
      seq += 1;
      const tx = { id: `cbtxn_${seq}`, amountCents: p.amountCents };
      byKey.set(p.idempotencyKey, tx);
      balances.set(
        p.customerId,
        (balances.get(p.customerId) ?? opts.balanceCents ?? 0) - p.amountCents,
      );
      return { id: tx.id };
    },
  };
  return { port, calls, balances, byKey };
}

/** Membresía viva de 3000 (30 €) y comisiones del referidor en los estados pedidos. */
function seedMember(
  prisma: MockPrisma,
  commissions: Array<{ amountCents: number; status: string; currency?: string }>,
  sub: Row = {},
) {
  prisma.subscriptions.push({
    tenantId: TENANT,
    userId: 'referrer-1',
    planId: 'plan-1',
    status: 'ACTIVE',
    stripeCustomerId: 'cus_referidor',
    unitAmount: 3000,
    currency: 'eur',
    ...sub,
  });
  const ids: string[] = [];
  commissions.forEach((c, i) => {
    const id = nextId('com');
    ids.push(id);
    prisma.commissions.push({
      id,
      tenantId: TENANT,
      referrerUserId: 'referrer-1',
      stripeInvoiceId: `in_seed_${i}`,
      amountCents: c.amountCents,
      currency: c.currency ?? 'eur',
      status: c.status,
      payoutId: null,
      approvedAt: new Date(Date.UTC(2026, 10, 1 + i)),
      createdAt: new Date(Date.UTC(2026, 9, 1 + i)),
    });
  });
  return ids;
}

describe('descuento en la cuota: configuración', () => {
  it('encendido por defecto (sin fila de config) y el creador lo apaga', async () => {
    const { service } = build({ config: null as never });
    expect((await service.getConfig(TENANT)).allowCreditRedemption).toBe(true);
    const next = await service.updateConfig(TENANT, { allowCreditRedemption: false });
    expect(next.allowCreditRedemption).toBe(false);
    expect((await service.getConfig(TENANT)).allowCreditRedemption).toBe(false);
  });
});

describe('descuento en la cuota: lo que ve el alumno (memberStats.credit)', () => {
  it('con membresía: suma las APPROVED sin pagar que caben en el 80 % de la cuota', async () => {
    const { port } = fakeCreditPort();
    const { prisma, service } = build({ creditPort: port });
    seedMember(prisma, [
      { amountCents: 900, status: 'APPROVED' },
      { amountCents: 900, status: 'APPROVED' },
      { amountCents: 900, status: 'APPROVED' }, // 2700 > 2400: no cabe
      { amountCents: 500, status: 'PENDING' }, // en garantía: no cuenta
      { amountCents: 300, status: 'APPROVED', currency: 'usd' }, // otra divisa
    ]);
    const { credit } = await service.memberStats(TENANT, 'referrer-1');
    expect(credit).toEqual({
      enabled: true,
      availableCents: 1800,
      currency: 'eur',
      maxCents: 2400,
      pending: false,
    });
  });

  it('sin membresía activa, con la opción apagada o sin Stripe: no aparece', async () => {
    const { port } = fakeCreditPort();
    const sinMembresia = build({ creditPort: port });
    seedMember(sinMembresia.prisma, [{ amountCents: 900, status: 'APPROVED' }], {
      status: 'CANCELED',
    });
    expect((await sinMembresia.service.memberStats(TENANT, 'referrer-1')).credit.enabled).toBe(
      false,
    );

    const apagado = build({ creditPort: port, config: { allowCreditRedemption: false } });
    seedMember(apagado.prisma, [{ amountCents: 900, status: 'APPROVED' }]);
    expect((await apagado.service.memberStats(TENANT, 'referrer-1')).credit.enabled).toBe(false);

    const sinStripe = build();
    seedMember(sinStripe.prisma, [{ amountCents: 900, status: 'APPROVED' }]);
    expect((await sinStripe.service.memberStats(TENANT, 'referrer-1')).credit.enabled).toBe(false);
  });
});

describe('descuento en la cuota: redeemAsCredit', () => {
  it('el abono en Stripe se describe como la línea de la factura: «Pago con saldo de referidos»', async () => {
    const { port } = fakeCreditPort();
    const descriptions: string[] = [];
    const spy: ReferralsCreditPort = {
      retrieveBalance: port.retrieveBalance,
      credit: async (tenantId, p) => {
        descriptions.push(p.description);
        return port.credit(tenantId, p);
      },
    };
    const { prisma, service } = build({ creditPort: spy });
    seedMember(prisma, [
      { amountCents: 400, status: 'APPROVED' },
      { amountCents: 200, status: 'APPROVED' },
    ]);
    await service.redeemAsCredit(TENANT, 'referrer-1');
    expect(descriptions).toEqual(['Pago con saldo de referidos (2 comisiones)']);
  });

  it('abona lo canjeable con la clave de su liquidación; las comisiones quedan PAID con la referencia', async () => {
    const { port, calls } = fakeCreditPort();
    const { prisma, service, events } = build({ creditPort: port });
    const ids = seedMember(prisma, [
      { amountCents: 900, status: 'APPROVED' },
      { amountCents: 300, status: 'APPROVED' },
      { amountCents: 500, status: 'PENDING' },
    ]);
    const result = await service.redeemAsCredit(TENANT, 'referrer-1');
    expect(result).toMatchObject({
      totalCents: 1200,
      currency: 'eur',
      count: 2,
      stripeBalanceTransactionId: 'cbtxn_1',
    });
    expect(calls).toEqual([
      {
        tenantId: TENANT,
        customerId: 'cus_referidor',
        amountCents: 1200,
        key: creditIdempotencyKey(result.payoutId),
      },
    ]);
    const payout = prisma.payouts.find((p) => p['id'] === result.payoutId)!;
    expect(payout).toMatchObject({
      method: 'CREDIT',
      status: 'DONE',
      externalReference: 'cbtxn_1',
      stripeCustomerId: 'cus_referidor',
      totalCents: 1200,
      createdByUserId: 'referrer-1',
    });
    expect(prisma.commissions.map((c) => [c['id'], c['status'], c['payoutId'] ?? null])).toEqual([
      [ids[0], 'PAID', result.payoutId],
      [ids[1], 'PAID', result.payoutId],
      [ids[2], 'PENDING', null],
    ]);
    expect(events.at(-1)).toMatchObject({
      name: 'referrals.payout.recorded',
      payload: { method: 'CREDIT', totalCents: 1200, externalReference: 'cbtxn_1' },
    });
    // Ya no queda nada que canjear: un segundo clic no abona otra vez.
    await expect(service.redeemAsCredit(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsCreditNothingError,
    );
    expect(calls).toHaveLength(1);
  });

  it('lo que ya tiene a favor en Stripe cuenta para el tope (no se apilan abonos)', async () => {
    const { port, calls } = fakeCreditPort({ balanceCents: -2000 });
    const { prisma, service } = build({ creditPort: port });
    seedMember(prisma, [
      { amountCents: 900, status: 'APPROVED' }, // no cabe en 400
      { amountCents: 300, status: 'APPROVED' },
    ]);
    const result = await service.redeemAsCredit(TENANT, 'referrer-1');
    expect(result.totalCents).toBe(300);
    expect(calls.map((c) => c.amountCents)).toEqual([300]);
  });

  it('Stripe falla: la liquidación queda PENDING y el reintento usa la MISMA clave e importe (un solo abono)', async () => {
    const { port, calls, byKey } = fakeCreditPort({ failTimes: 1 });
    const { prisma, service } = build({ creditPort: port });
    seedMember(prisma, [{ amountCents: 900, status: 'APPROVED' }]);
    await expect(service.redeemAsCredit(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsCreditFailedError,
    );
    expect(prisma.payouts).toHaveLength(1);
    expect(prisma.payouts[0]).toMatchObject({ status: 'PENDING', method: 'CREDIT' });
    expect(prisma.commissions[0]).toMatchObject({ status: 'PAID' });
    expect((await service.memberStats(TENANT, 'referrer-1')).credit.pending).toBe(true);

    // Entretanto aprueban otra comisión: el reintento NO la mete en el abono a medias.
    seedMember(prisma, [{ amountCents: 400, status: 'APPROVED' }]);
    const retried = await service.redeemAsCredit(TENANT, 'referrer-1');
    expect(retried).toMatchObject({ totalCents: 900, count: 1 });
    expect(calls.map((c) => [c.key, c.amountCents])).toEqual([
      [creditIdempotencyKey(retried.payoutId), 900],
      [creditIdempotencyKey(retried.payoutId), 900],
    ]);
    expect(byKey.size).toBe(1);
    expect(prisma.payouts).toHaveLength(1);
    expect(prisma.payouts[0]).toMatchObject({ status: 'DONE', externalReference: 'cbtxn_1' });
  });

  it('dos canjes a la vez: uno abona, el otro no encuentra nada', async () => {
    const { port, calls } = fakeCreditPort();
    const { prisma, service } = build({ creditPort: port });
    seedMember(prisma, [{ amountCents: 900, status: 'APPROVED' }]);
    const results = await Promise.allSettled([
      service.redeemAsCredit(TENANT, 'referrer-1'),
      service.redeemAsCredit(TENANT, 'referrer-1'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ReferralsCreditNothingError);
    expect(calls).toHaveLength(1);
  });

  it('reglas: opción apagada, sin Stripe, sin membresía, sin nada aprobado', async () => {
    const { port } = fakeCreditPort();
    const apagado = build({ creditPort: port, config: { allowCreditRedemption: false } });
    seedMember(apagado.prisma, [{ amountCents: 900, status: 'APPROVED' }]);
    await expect(apagado.service.redeemAsCredit(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsCreditDisabledError,
    );

    const sinStripe = build();
    seedMember(sinStripe.prisma, [{ amountCents: 900, status: 'APPROVED' }]);
    await expect(sinStripe.service.redeemAsCredit(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsCreditUnavailableError,
    );

    const sinMembresia = build({ creditPort: port });
    seedMember(sinMembresia.prisma, [{ amountCents: 900, status: 'APPROVED' }], {
      status: 'PAST_DUE',
    });
    await expect(sinMembresia.service.redeemAsCredit(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsMembershipRequiredError,
    );

    const nada = build({ creditPort: port });
    seedMember(nada.prisma, [{ amountCents: 900, status: 'PENDING' }]);
    await expect(nada.service.redeemAsCredit(TENANT, 'referrer-1')).rejects.toBeInstanceOf(
      ReferralsCreditNothingError,
    );
    expect(nada.prisma.payouts).toEqual([]);
  });
});

describe('utcDay', () => {
  it('devuelve YYYY-MM-DD en UTC', () => {
    expect(utcDay(new Date('2026-07-24T23:59:59Z'))).toBe('2026-07-24');
  });
});
