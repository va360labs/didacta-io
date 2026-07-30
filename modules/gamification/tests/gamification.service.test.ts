import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHALLENGE_RULE_KEY,
  DEFAULT_RULES,
  GamificationService,
  dayStartUtc,
  rangeStartUtc,
  type GamificationEventPublisher,
} from '../src/gamification.service.js';
import {
  GamificationAlreadyReviewedError,
  GamificationAlreadySubmittedError,
  GamificationChallengeClosedError,
  GamificationPerkUnavailableError,
  GamificationValidationError,
} from '../src/errors.js';

// ============================================================================
// Tests del dominio mod.gamification con un MockPrisma in-memory (sin BD ni red).
// El foco está en lo que puede costar dinero o credibilidad: idempotencia del
// ledger frente a la reentrega del bus, techos diarios, revocación sin bajar de
// nivel, ranking con el total sin truncar, y que un reto no se pueda cobrar dos
// veces revisándolo dos veces.
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

/** Aplica los operadores de Prisma que usa el service (gte, lt, lte, not, in). */
function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
    const cond = expected as Row;
    if ('gte' in cond && !(compare(actual, cond['gte']) >= 0)) return false;
    if ('gt' in cond && !(compare(actual, cond['gt']) > 0)) return false;
    if ('lte' in cond && !(compare(actual, cond['lte']) <= 0)) return false;
    if ('lt' in cond && !(compare(actual, cond['lt']) < 0)) return false;
    if ('not' in cond && actual === cond['not']) return false;
    if ('in' in cond && !(cond['in'] as unknown[]).includes(actual)) return false;
    return true;
  }
  return actual === expected;
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number);
  const bv = b instanceof Date ? b.getTime() : (b as number);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(expected as Row[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(row, expected as Row)) return false;
      continue;
    }
    if (!matchesValue(row[key], expected)) return false;
  }
  return true;
}

function makeTable(rows: Row[], defaults: () => Row, uniqueKeys: string[][]) {
  const findUniqueRow = (where: Row): Row | undefined => {
    // Prisma expone las uniques compuestas como un objeto anidado.
    const flat: Row = {};
    for (const [k, v] of Object.entries(where)) {
      if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
        Object.assign(flat, v as Row);
      } else {
        flat[k] = v;
      }
    }
    return rows.find((r) => matches(r, flat));
  };

  return {
    rows,
    create: async ({ data }: never) => {
      const d = data as Row;
      for (const keys of uniqueKeys) {
        if (rows.some((r) => keys.every((k) => r[k] === d[k]))) throw uniqueViolation();
      }
      const row: Row = { ...defaults(), ...d };
      rows.push(row);
      return { ...row };
    },
    findUnique: async ({ where }: never) => {
      const row = findUniqueRow(where as Row);
      return row ? { ...row } : null;
    },
    findFirst: async ({ where, orderBy }: never) => {
      let found = rows.filter((r) => matches(r, where as Row));
      if (orderBy) found = sortRows(found, orderBy as Row);
      return found[0] ? { ...found[0] } : null;
    },
    findMany: async ({ where, orderBy, take }: never) => {
      let found = rows.filter((r) => matches(r, where as Row));
      if (orderBy) found = sortRows(found, orderBy as Row);
      if (take) found = found.slice(0, take as number);
      return found.map((r) => ({ ...r }));
    },
    count: async ({ where }: never) => rows.filter((r) => matches(r, where as Row)).length,
    updateMany: async ({ where, data }: never) => {
      const target = rows.filter((r) => matches(r, where as Row));
      for (const row of target) applyData(row, data as Row);
      return { count: target.length };
    },
    deleteMany: async ({ where }: never) => {
      const target = rows.filter((r) => matches(r, where as Row));
      for (const row of target) rows.splice(rows.indexOf(row), 1);
      return { count: target.length };
    },
    upsert: async ({ where, update, create }: never) => {
      const existing = findUniqueRow(where as Row);
      if (existing) {
        applyData(existing, update as Row);
        return { ...existing };
      }
      const row: Row = { ...defaults(), ...(create as Row) };
      rows.push(row);
      return { ...row };
    },
  };
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const op = value as Row;
      if ('increment' in op) {
        row[key] = (row[key] as number) + (op['increment'] as number);
        continue;
      }
      if ('decrement' in op) {
        row[key] = (row[key] as number) - (op['decrement'] as number);
        continue;
      }
    }
    row[key] = value;
  }
}

function sortRows(rows: Row[], orderBy: Row): Row[] {
  const [key, dir] = Object.entries(orderBy)[0] as [string, string];
  return [...rows].sort((a, b) => {
    const cmp = compare(a[key], b[key]);
    return dir === 'desc' ? -cmp : cmp;
  });
}

class MockPrisma {
  entries: Row[] = [];
  profiles: Row[] = [];
  rules: Row[] = [];
  levels: Row[] = [];
  challenges: Row[] = [];
  submissions: Row[] = [];
  perks: Row[] = [];
  perkRequests: Row[] = [];

  modGamificationLedgerEntry = {
    ...makeTable(
      this.entries,
      () => ({
        id: nextId('led'),
        meta: null,
        revokedAt: null,
        revokeReason: null,
        createdAt: new Date(),
      }),
      [['tenantId', 'userId', 'sourceKey']],
    ),
    groupBy: async ({ by, where }: never) => {
      const field = (by as string[])[0]!;
      const found = this.entries.filter((r) => matches(r, where as Row));
      const sums = new Map<unknown, number>();
      for (const row of found) {
        sums.set(row[field], (sums.get(row[field]) ?? 0) + (row['points'] as number));
      }
      return [...sums.entries()].map(([value, sum]) => ({
        [field]: value,
        _sum: { points: sum },
      }));
    },
    aggregate: async ({ where }: never) => {
      const found = this.entries.filter((r) => matches(r, where as Row));
      return {
        _sum: {
          points: found.length ? found.reduce((acc, r) => acc + (r['points'] as number), 0) : null,
        },
      };
    },
  };

  modGamificationProfile = makeTable(
    this.profiles,
    () => ({
      id: nextId('prof'),
      lifetimePoints: 0,
      levelKey: null,
      levelReachedAt: null,
      updatedAt: new Date(),
    }),
    [['tenantId', 'userId']],
  );

  modGamificationRule = makeTable(
    this.rules,
    () => ({
      id: nextId('rule'),
      dailyCap: 0,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    [['tenantId', 'key']],
  );

  modGamificationLevel = makeTable(
    this.levels,
    () => ({
      id: nextId('lvl'),
      benefitText: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    [
      ['tenantId', 'key'],
      ['tenantId', 'minPoints'],
    ],
  );

  modGamificationPerk = {
    ...makeTable(
      this.perks,
      () => ({
        id: nextId('perk'),
        description: null,
        maxPerUser: 1,
        cooldownDays: 0,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      [],
    ),
    findFirst: async ({ where, include }: never) => {
      const row = this.perks.find((r) => matches(r, where as Row));
      if (!row) return null;
      return this.hydratePerk(row, include as Row | undefined);
    },
    findMany: async ({ where, include }: never) => {
      const found = this.perks.filter((r) => matches(r, where as Row));
      return found.map((row) => this.hydratePerk(row, include as Row | undefined));
    },
  };

  modGamificationPerkRequest = {
    ...makeTable(
      this.perkRequests,
      () => ({
        id: nextId('preq'),
        note: null,
        status: 'PENDING',
        handledById: null,
        handledAt: null,
        staffNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      [],
    ),
    findMany: async ({ where, include }: never) => {
      const found = this.perkRequests.filter((r) => matches(r, where as Row));
      return found
        .slice()
        .sort((a, b) => (b['createdAt'] as Date).getTime() - (a['createdAt'] as Date).getTime())
        .map((row) => {
          const out: Row = { ...row };
          if ((include as Row | undefined)?.['perk']) {
            const perk = this.perks.find((p) => p['id'] === row['perkId']);
            out['perk'] = { title: perk?.['title'] };
          }
          return out;
        });
    },
  };

  private hydratePerk(row: Row, include?: Row): Row {
    const out: Row = { ...row };
    if (include?.['level']) {
      const level = this.levels.find((l) => l['id'] === row['levelId']);
      out['level'] = { name: level?.['name'], minPoints: level?.['minPoints'] };
    }
    return out;
  }

  modGamificationChallenge = {
    ...makeTable(
      this.challenges,
      () => ({
        id: nextId('chl'),
        description: null,
        proofRequired: true,
        status: 'DRAFT',
        startsAt: null,
        endsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      [],
    ),
  };

  modGamificationSubmission = {
    ...makeTable(
      this.submissions,
      () => ({
        id: nextId('sub'),
        proofUrl: null,
        proofName: null,
        note: null,
        status: 'PENDING',
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      [['tenantId', 'challengeId', 'userId']],
    ),
    findFirst: async ({ where, include }: never) => {
      const row = this.submissions.find((r) => matches(r, where as Row));
      if (!row) return null;
      const out: Row = { ...row };
      if ((include as Row | undefined)?.['challenge']) {
        const challenge = this.challenges.find((c) => c['id'] === row['challengeId']);
        out['challenge'] = { points: challenge?.['points'], title: challenge?.['title'] };
      }
      return out;
    },
    findMany: async ({ where, include }: never) => {
      const found = this.submissions.filter((r) => matches(r, where as Row));
      return found.map((row) => {
        const out: Row = { ...row };
        if ((include as Row | undefined)?.['challenge']) {
          const challenge = this.challenges.find((c) => c['id'] === row['challengeId']);
          out['challenge'] = { title: challenge?.['title'] };
        }
        return out;
      });
    },
  };

  async $transaction<T>(fn: (tx: MockPrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const TENANT = 'tenant-1';
const USER = 'user-1';

function build() {
  const prisma = new MockPrisma();
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const publisher: GamificationEventPublisher = {
    publish: async (_tenantId, _actorId, name, payload) => {
      events.push({ name, payload });
    },
  };
  const service = new GamificationService(prisma as never, publisher);
  return { prisma, service, events };
}

beforeEach(() => {
  idSeq = 0;
});

describe('rangos temporales', () => {
  it('rangeStartUtc calcula en UTC, no en hora local del servidor', () => {
    const now = new Date('2026-03-15T10:00:00.000Z');
    expect(rangeStartUtc('week', now)?.toISOString()).toBe('2026-03-08T10:00:00.000Z');
    expect(rangeStartUtc('month', now)?.toISOString()).toBe('2026-02-15T10:00:00.000Z');
    expect(rangeStartUtc('all', now)).toBeUndefined();
  });

  it('dayStartUtc corta el día en UTC', () => {
    expect(dayStartUtc(new Date('2026-03-15T23:30:00.000Z')).toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });
});

describe('ledger', () => {
  it('acredita puntos de la regla y crea el perfil', async () => {
    const { service, prisma, events } = build();
    const result = await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });

    expect(result.awarded).toBe(true);
    expect(result.points).toBe(10);
    expect(prisma.profiles).toHaveLength(1);
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(10);
    expect(events.map((e) => e.name)).toEqual(['gamification.points.awarded']);
  });

  it('es idempotente: el mismo hecho no se paga dos veces aunque el bus reentregue', async () => {
    const { service, prisma } = build();
    const args = {
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    };
    await service.award(args);
    const second = await service.award(args);

    expect(second.awarded).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(prisma.entries).toHaveLength(1);
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(10);
  });

  it('el mismo hecho sí puede acreditar a dos personas distintas', async () => {
    const { service, prisma } = build();
    await service.award({
      tenantId: TENANT,
      userId: 'a',
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });
    await service.award({
      tenantId: TENANT,
      userId: 'b',
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });
    expect(prisma.entries).toHaveLength(2);
  });

  it('el techo diario corta a partir del enésimo asiento del día', async () => {
    const { service, prisma } = build();
    const day = new Date('2026-03-15T08:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await service.award({
        tenantId: TENANT,
        userId: USER,
        ruleKey: 'community.post',
        sourceKey: `community.post:p${i}`,
        occurredAt: day,
      });
    }
    // dailyCap de community.post es 3.
    expect(prisma.entries).toHaveLength(3);
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(30);
  });

  it('el techo diario se reinicia al día siguiente', async () => {
    const { service, prisma } = build();
    for (let i = 0; i < 3; i += 1) {
      await service.award({
        tenantId: TENANT,
        userId: USER,
        ruleKey: 'community.post',
        sourceKey: `d1-${i}`,
        occurredAt: new Date('2026-03-15T08:00:00.000Z'),
      });
    }
    const nextDay = await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'd2-0',
      occurredAt: new Date('2026-03-16T08:00:00.000Z'),
    });
    expect(nextDay.awarded).toBe(true);
    expect(prisma.entries).toHaveLength(4);
  });

  it('una regla desactivada no acredita', async () => {
    const { service, prisma } = build();
    await service.listRules(TENANT);
    await service.updateRule(TENANT, 'community.post', { enabled: false });

    const result = await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe('rule_disabled');
    expect(prisma.entries).toHaveLength(0);
  });

  it('los puntos explícitos ignoran el catálogo y su techo', async () => {
    const { service } = build();
    const result = await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: CHALLENGE_RULE_KEY,
      sourceKey: 'challenge:s1',
      points: 250,
    });
    expect(result.awarded).toBe(true);
    expect(result.points).toBe(250);
  });
});

describe('revocación', () => {
  it('marca el asiento y descuenta, sin borrar la fila', async () => {
    const { service, prisma, events } = build();
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });

    const result = await service.revoke({
      tenantId: TENANT,
      sourceKey: 'community.post:p1',
      reason: 'post borrado',
    });

    expect(result.revoked).toBe(1);
    expect(prisma.entries).toHaveLength(1);
    expect(prisma.entries[0]!['revokedAt']).not.toBeNull();
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(0);
    expect(events.map((e) => e.name)).toContain('gamification.points.revoked');
  });

  it('revocar dos veces no descuenta dos veces', async () => {
    const { service, prisma } = build();
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });
    await service.revoke({ tenantId: TENANT, sourceKey: 'community.post:p1', reason: 'x' });
    const second = await service.revoke({
      tenantId: TENANT,
      sourceKey: 'community.post:p1',
      reason: 'x',
    });

    expect(second.revoked).toBe(0);
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(0);
  });

  it('restaurar lo ocultado devuelve los puntos', async () => {
    const { service, prisma } = build();
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });
    await service.revoke({ tenantId: TENANT, sourceKey: 'community.post:p1', reason: 'oculto' });
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(0);

    const result = await service.restore({ tenantId: TENANT, sourceKey: 'community.post:p1' });

    expect(result.restored).toBe(1);
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(10);
    expect(prisma.entries[0]!['revokedAt']).toBeNull();
  });

  it('restaurar dos veces no suma dos veces', async () => {
    const { service, prisma } = build();
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });
    await service.revoke({ tenantId: TENANT, sourceKey: 'community.post:p1', reason: 'oculto' });
    await service.restore({ tenantId: TENANT, sourceKey: 'community.post:p1' });
    const second = await service.restore({ tenantId: TENANT, sourceKey: 'community.post:p1' });

    expect(second.restored).toBe(0);
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(10);
  });

  it('el nivel alcanzado NO baja aunque bajen los puntos', async () => {
    const { service, prisma } = build();
    await service.createLevel({ tenantId: TENANT, key: 'n1', name: 'Nivel 1', minPoints: 10 });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'community.post:p1',
    });
    expect(prisma.profiles[0]!['levelKey']).toBe('n1');

    await service.revoke({ tenantId: TENANT, sourceKey: 'community.post:p1', reason: 'x' });
    expect(prisma.profiles[0]!['levelKey']).toBe('n1');
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(0);
  });
});

describe('niveles', () => {
  it('sube de nivel al cruzar el mínimo y emite level.changed', async () => {
    const { service, events } = build();
    await service.createLevel({ tenantId: TENANT, key: 'bronce', name: 'Bronce', minPoints: 10 });
    await service.createLevel({ tenantId: TENANT, key: 'plata', name: 'Plata', minPoints: 20 });

    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'p1',
    });
    const second = await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'p2',
    });

    expect(second.levelChange).toEqual({ from: 'bronce', to: 'plata' });
    const changes = events.filter((e) => e.name === 'gamification.level.changed');
    expect(changes).toHaveLength(2);
  });

  it('sin niveles definidos nadie tiene nivel', async () => {
    const { service, prisma } = build();
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'p1',
    });
    expect(prisma.profiles[0]!['levelKey']).toBeNull();
  });

  it('crear un nivel reasigna a quien ya tenía puntos suficientes', async () => {
    const { service, prisma } = build();
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });
    expect(prisma.profiles[0]!['levelKey']).toBeNull();

    await service.createLevel({ tenantId: TENANT, key: 'bronce', name: 'Bronce', minPoints: 25 });
    expect(prisma.profiles[0]!['levelKey']).toBe('bronce');
  });

  it('borrar el nivel más alto devuelve a los perfiles al inferior', async () => {
    const { service, prisma } = build();
    await service.createLevel({ tenantId: TENANT, key: 'bronce', name: 'Bronce', minPoints: 10 });
    const plata = await service.createLevel({
      tenantId: TENANT,
      key: 'plata',
      name: 'Plata',
      minPoints: 40,
    });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });
    expect(prisma.profiles[0]!['levelKey']).toBe('plata');

    await service.deleteLevel(TENANT, plata.id);
    expect(prisma.profiles[0]!['levelKey']).toBe('bronce');
  });
});

describe('beneficios de nivel', () => {
  async function setup() {
    const ctx = build();
    const level = await ctx.service.createLevel({
      tenantId: TENANT,
      key: 'plata',
      name: 'Plata',
      minPoints: 50,
    });
    return { ...ctx, level };
  }

  it('un beneficio aparece bloqueado si no llegas a los puntos del nivel', async () => {
    const { service, level } = await setup();
    await service.createPerk({
      tenantId: TENANT,
      levelId: level.id,
      title: 'Sesión 1:1 de 30 minutos',
    });

    const mine = await service.listMyPerks(TENANT, USER);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.unlocked).toBe(false);
    expect(mine[0]!.canRequest).toBe(false);
  });

  it('se desbloquea al llegar a los puntos, sin esperar a re-puntuar', async () => {
    const { service, level } = await setup();
    await service.createPerk({ tenantId: TENANT, levelId: level.id, title: 'Clase extra' });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });

    const mine = await service.listMyPerks(TENANT, USER);
    expect(mine[0]!.unlocked).toBe(true);
    expect(mine[0]!.canRequest).toBe(true);
  });

  it('no se puede pedir sin nivel suficiente', async () => {
    const { service, level } = await setup();
    const perk = await service.createPerk({
      tenantId: TENANT,
      levelId: level.id,
      title: 'Píldora personalizada',
    });
    await expect(
      service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id }),
    ).rejects.toBeInstanceOf(GamificationPerkUnavailableError);
  });

  it('la solicitud queda PENDIENTE: nada se concede solo', async () => {
    const { service, level, events } = await setup();
    const perk = await service.createPerk({ tenantId: TENANT, levelId: level.id, title: '1:1' });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });

    const request = await service.requestPerk({
      tenantId: TENANT,
      userId: USER,
      perkId: perk.id,
      note: 'Quiero repasar mi embudo.',
    });

    expect(request.status).toBe('PENDING');
    expect(events.map((e) => e.name)).toContain('gamification.perk.requested');
  });

  it('respeta el cupo por alumno', async () => {
    const { service, level } = await setup();
    const perk = await service.createPerk({
      tenantId: TENANT,
      levelId: level.id,
      title: '1:1',
      maxPerUser: 1,
    });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });
    await service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id });

    await expect(
      service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id }),
    ).rejects.toBeInstanceOf(GamificationPerkUnavailableError);
  });

  it('respeta la espera entre solicitudes', async () => {
    const { service, level } = await setup();
    const perk = await service.createPerk({
      tenantId: TENANT,
      levelId: level.id,
      title: '1:1 mensual',
      maxPerUser: 0,
      cooldownDays: 30,
    });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });
    await service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id });

    await expect(
      service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id }),
    ).rejects.toBeInstanceOf(GamificationPerkUnavailableError);

    // Pasada la espera vuelve a poder pedirlo.
    const later = new Date(Date.now() + 31 * 86_400_000);
    const second = await service.requestPerk({
      tenantId: TENANT,
      userId: USER,
      perkId: perk.id,
      now: later,
    });
    expect(second.status).toBe('PENDING');
  });

  it('un beneficio rechazado no consume cupo', async () => {
    const { service, level } = await setup();
    const perk = await service.createPerk({
      tenantId: TENANT,
      levelId: level.id,
      title: '1:1',
      maxPerUser: 1,
    });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });
    const request = await service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id });
    await service.handlePerkRequest({
      tenantId: TENANT,
      requestId: request.id,
      handledById: 'admin',
      status: 'REJECTED',
      staffNote: 'Esta semana no tengo hueco.',
    });

    const second = await service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id });
    expect(second.status).toBe('PENDING');
  });

  it('atender dos veces la misma solicitud falla', async () => {
    const { service, level } = await setup();
    const perk = await service.createPerk({ tenantId: TENANT, levelId: level.id, title: '1:1' });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });
    const request = await service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id });
    await service.handlePerkRequest({
      tenantId: TENANT,
      requestId: request.id,
      handledById: 'admin',
      status: 'DONE',
    });

    await expect(
      service.handlePerkRequest({
        tenantId: TENANT,
        requestId: request.id,
        handledById: 'admin',
        status: 'DONE',
      }),
    ).rejects.toBeInstanceOf(GamificationAlreadyReviewedError);
  });

  it('un beneficio desactivado no se lista ni se puede pedir', async () => {
    const { service, level } = await setup();
    const perk = await service.createPerk({ tenantId: TENANT, levelId: level.id, title: '1:1' });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'learning.course',
      sourceKey: 'c1',
    });
    await service.updatePerk(TENANT, perk.id, { active: false });

    expect(await service.listMyPerks(TENANT, USER)).toHaveLength(0);
    await expect(
      service.requestPerk({ tenantId: TENANT, userId: USER, perkId: perk.id }),
    ).rejects.toBeInstanceOf(GamificationPerkUnavailableError);
  });
});

describe('ranking', () => {
  it('ordena por puntos y devuelve el total sin truncar', async () => {
    const { service } = build();
    const now = new Date('2026-03-15T10:00:00.000Z');
    await service.award({
      tenantId: TENANT,
      userId: 'a',
      ruleKey: 'community.post',
      sourceKey: 'a1',
    });
    await service.award({
      tenantId: TENANT,
      userId: 'b',
      ruleKey: 'learning.course',
      sourceKey: 'b1',
    });
    await service.award({
      tenantId: TENANT,
      userId: 'c',
      ruleKey: 'community.comment',
      sourceKey: 'c1',
    });

    const board = await service.leaderboard(TENANT, 'all', 2, now);
    expect(board.rows.map((r) => r.userId)).toEqual(['b', 'a']);
    expect(board.rows[0]!.rank).toBe(1);
    // El total es la población completa, no el tamaño de la página: el «Top X%»
    // del perfil se calculaba antes contra la lista truncada y salía mal.
    expect(board.total).toBe(3);
  });

  it('los asientos revocados no puntúan', async () => {
    const { service } = build();
    await service.award({
      tenantId: TENANT,
      userId: 'a',
      ruleKey: 'community.post',
      sourceKey: 'a1',
    });
    await service.revoke({ tenantId: TENANT, sourceKey: 'a1', reason: 'x' });

    const board = await service.leaderboard(TENANT, 'all');
    expect(board.rows).toHaveLength(0);
    expect(board.total).toBe(0);
  });

  it('el puesto propio se calcula sobre toda la población', async () => {
    const { service } = build();
    await service.award({
      tenantId: TENANT,
      userId: 'a',
      ruleKey: 'learning.course',
      sourceKey: 'a1',
    });
    await service.award({
      tenantId: TENANT,
      userId: USER,
      ruleKey: 'community.post',
      sourceKey: 'u1',
    });

    const standing = await service.standing(TENANT, USER);
    expect(standing.points).toBe(10);
    expect(standing.rank).toBe(2);
    expect(standing.total).toBe(2);
  });

  it('quien no tiene puntos no tiene puesto', async () => {
    const { service } = build();
    const standing = await service.standing(TENANT, 'nadie');
    expect(standing.rank).toBeNull();
    expect(standing.points).toBe(0);
  });
});

describe('reglas', () => {
  it('siembra el catálogo por defecto en el primer listado', async () => {
    const { service, prisma } = build();
    const rules = await service.listRules(TENANT);
    expect(rules).toHaveLength(DEFAULT_RULES.length);
    expect(prisma.rules).toHaveLength(DEFAULT_RULES.length);

    // Los pesos del ranking anterior se conservan para no mover a nadie de sitio.
    expect(rules.find((r) => r.key === 'community.post')?.points).toBe(10);
    expect(rules.find((r) => r.key === 'community.comment')?.points).toBe(5);
  });

  it('sembrar es idempotente entre dos listados simultáneos', async () => {
    const { service, prisma } = build();
    await Promise.all([service.listRules(TENANT), service.listRules(TENANT)]);
    expect(prisma.rules).toHaveLength(DEFAULT_RULES.length);
  });
});

describe('retos', () => {
  async function openChallenge(service: GamificationService, points = 100, proofRequired = true) {
    const challenge = await service.createChallenge({
      tenantId: TENANT,
      createdById: 'admin',
      title: 'Publica tu caso de éxito',
      points,
      proofRequired,
      status: 'OPEN',
    });
    return challenge;
  }

  it('exige la prueba cuando el reto la pide', async () => {
    const { service } = build();
    const challenge = await openChallenge(service);
    await expect(
      service.submitChallenge({ tenantId: TENANT, userId: USER, challengeId: challenge.id }),
    ).rejects.toBeInstanceOf(GamificationValidationError);
  });

  it('acepta la entrega con prueba y emite el evento', async () => {
    const { service, events } = build();
    const challenge = await openChallenge(service);
    const submission = await service.submitChallenge({
      tenantId: TENANT,
      userId: USER,
      challengeId: challenge.id,
      proofUrl: '/api/v1/storage/file/tenants/t/uploads/1-captura.png',
    });
    expect(submission.status).toBe('PENDING');
    expect(events.map((e) => e.name)).toContain('gamification.challenge.submitted');
  });

  it('rechaza una URL de prueba que no sea del storage ni http(s)', async () => {
    const { service } = build();
    const challenge = await openChallenge(service);
    await expect(
      service.submitChallenge({
        tenantId: TENANT,
        userId: USER,
        challengeId: challenge.id,
        proofUrl: '/etc/passwd',
      }),
    ).rejects.toBeInstanceOf(GamificationValidationError);
  });

  it('una sola entrega por reto y persona', async () => {
    const { service } = build();
    const challenge = await openChallenge(service);
    const proofUrl = 'https://ejemplo.com/workflow.json';
    await service.submitChallenge({
      tenantId: TENANT,
      userId: USER,
      challengeId: challenge.id,
      proofUrl,
    });
    await expect(
      service.submitChallenge({
        tenantId: TENANT,
        userId: USER,
        challengeId: challenge.id,
        proofUrl,
      }),
    ).rejects.toBeInstanceOf(GamificationAlreadySubmittedError);
  });

  it('un reto en borrador no admite entregas', async () => {
    const { service } = build();
    const challenge = await service.createChallenge({
      tenantId: TENANT,
      createdById: 'admin',
      title: 'Todavía no',
      points: 50,
      status: 'DRAFT',
    });
    await expect(
      service.submitChallenge({
        tenantId: TENANT,
        userId: USER,
        challengeId: challenge.id,
        proofUrl: 'https://ejemplo.com/x.png',
      }),
    ).rejects.toBeInstanceOf(GamificationChallengeClosedError);
  });

  it('un reto fuera de fechas no admite entregas', async () => {
    const { service } = build();
    const challenge = await service.createChallenge({
      tenantId: TENANT,
      createdById: 'admin',
      title: 'Caducado',
      points: 50,
      status: 'OPEN',
      endsAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await expect(
      service.submitChallenge({
        tenantId: TENANT,
        userId: USER,
        challengeId: challenge.id,
        proofUrl: 'https://ejemplo.com/x.png',
        now: new Date('2026-03-15T00:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(GamificationChallengeClosedError);
  });

  it('aprobar acredita los puntos del reto', async () => {
    const { service, prisma } = build();
    const challenge = await openChallenge(service, 100);
    const submission = await service.submitChallenge({
      tenantId: TENANT,
      userId: USER,
      challengeId: challenge.id,
      proofUrl: 'https://ejemplo.com/x.png',
    });

    const review = await service.reviewSubmission({
      tenantId: TENANT,
      submissionId: submission.id,
      reviewerId: 'admin',
      approve: true,
    });

    expect(review.status).toBe('APPROVED');
    expect(review.awarded).toBe(true);
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(100);
  });

  it('revisar dos veces no paga dos veces', async () => {
    const { service, prisma } = build();
    const challenge = await openChallenge(service, 100);
    const submission = await service.submitChallenge({
      tenantId: TENANT,
      userId: USER,
      challengeId: challenge.id,
      proofUrl: 'https://ejemplo.com/x.png',
    });
    await service.reviewSubmission({
      tenantId: TENANT,
      submissionId: submission.id,
      reviewerId: 'admin',
      approve: true,
    });

    await expect(
      service.reviewSubmission({
        tenantId: TENANT,
        submissionId: submission.id,
        reviewerId: 'admin',
        approve: true,
      }),
    ).rejects.toBeInstanceOf(GamificationAlreadyReviewedError);
    expect(prisma.profiles[0]!['lifetimePoints']).toBe(100);
  });

  it('rechazar no acredita nada', async () => {
    const { service, prisma } = build();
    const challenge = await openChallenge(service, 100);
    const submission = await service.submitChallenge({
      tenantId: TENANT,
      userId: USER,
      challengeId: challenge.id,
      proofUrl: 'https://ejemplo.com/x.png',
    });

    const review = await service.reviewSubmission({
      tenantId: TENANT,
      submissionId: submission.id,
      reviewerId: 'admin',
      approve: false,
      reviewNote: 'Falta el enlace al workflow.',
    });

    expect(review.status).toBe('REJECTED');
    expect(review.awarded).toBe(false);
    expect(prisma.profiles).toHaveLength(0);
  });

  it('el alumno solo ve los retos abiertos y con su estado de entrega', async () => {
    const { service } = build();
    const open = await openChallenge(service);
    await service.createChallenge({
      tenantId: TENANT,
      createdById: 'admin',
      title: 'Borrador',
      points: 10,
      status: 'DRAFT',
    });
    await service.submitChallenge({
      tenantId: TENANT,
      userId: USER,
      challengeId: open.id,
      proofUrl: 'https://ejemplo.com/x.png',
    });

    const visible = await service.listOpenChallenges(TENANT, USER);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.mySubmission?.status).toBe('PENDING');
  });
});
