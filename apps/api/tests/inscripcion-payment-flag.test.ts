/**
 * Tests de `MemberPaymentFlagService` (gestión admin de impagos —
 * tabla member_payment_flag — que alimenta la validación manual de inscripción).
 *
 * Cubre:
 *  - upsert: usa la clave compuesta tenantId_telegramId y audita.
 *  - list: filtra por tenantId (+ delinquentOnly opcional).
 *  - remove: borra vía deleteMany filtrando por tenantId (sin borrados cruzados).
 *  - importCsv: upserta N filas dentro de $transaction y devuelve { imported: N }.
 *  - lookup: devuelve { isDelinquent, name } o null si no hay flag.
 *
 * Patrón fake-prisma in-memory (clon de password-reset.test.ts): sin DB real.
 */

import { describe, expect, it } from 'vitest';
import { MemberPaymentFlagService } from '../src/inscripcion/member-payment-flag.service';
import type { PaymentFlagUpsertDto } from '../src/inscripcion/inscripcion.dto';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const ACTOR_ID = 'admin-user';
const CTX = { ip: '203.0.113.7', userAgent: 'vitest-agent' };

interface FlagRow {
  id: string;
  tenantId: string;
  telegramId: string;
  name: string | null;
  isDelinquent: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakePrisma() {
  const flags: FlagRow[] = [];
  let autoId = 1;

  const memberPaymentFlag = {
    async upsert(args: {
      where: { tenantId_telegramId: { tenantId: string; telegramId: string } };
      create: {
        tenantId: string;
        telegramId: string;
        name: string | null;
        isDelinquent: boolean;
        note: string | null;
      };
      update: { name: string | null; isDelinquent: boolean; note: string | null };
    }) {
      const { tenantId, telegramId } = args.where.tenantId_telegramId;
      const existing = flags.find((f) => f.tenantId === tenantId && f.telegramId === telegramId);
      if (existing) {
        existing.name = args.update.name;
        existing.isDelinquent = args.update.isDelinquent;
        existing.note = args.update.note;
        existing.updatedAt = new Date();
        return existing;
      }
      const row: FlagRow = {
        id: `flag-${autoId++}`,
        ...args.create,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      flags.push(row);
      return row;
    },
    async findMany(args: {
      where: {
        tenantId: string;
        isDelinquent?: boolean;
        OR?: Array<
          { telegramId: { contains: string } } | { name: { contains: string; mode: 'insensitive' } }
        >;
      };
      orderBy: { updatedAt: 'desc' };
      take: number;
    }) {
      let result = flags.filter((f) => f.tenantId === args.where.tenantId);
      if (args.where.isDelinquent !== undefined) {
        result = result.filter((f) => f.isDelinquent === args.where.isDelinquent);
      }
      if (args.where.OR) {
        result = result.filter((f) =>
          args.where.OR!.some((cond) => {
            if ('telegramId' in cond) return f.telegramId.includes(cond.telegramId.contains);
            const needle = cond.name.contains.toLowerCase();
            return (f.name ?? '').toLowerCase().includes(needle);
          }),
        );
      }
      result = [...result].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return result.slice(0, args.take);
    },
    async deleteMany(args: { where: { tenantId: string; id: string } }) {
      let count = 0;
      for (let i = flags.length - 1; i >= 0; i--) {
        if (flags[i].tenantId === args.where.tenantId && flags[i].id === args.where.id) {
          flags.splice(i, 1);
          count++;
        }
      }
      return { count };
    },
    async findUnique(args: {
      where: { tenantId_telegramId: { tenantId: string; telegramId: string } };
      select: { isDelinquent: true; name: true };
    }) {
      const { tenantId, telegramId } = args.where.tenantId_telegramId;
      const f = flags.find((x) => x.tenantId === tenantId && x.telegramId === telegramId);
      if (!f) return null;
      return { isDelinquent: f.isDelinquent, name: f.name };
    },
  };

  return {
    flags,
    memberPaymentFlag,
    // El service pasa `rows.map((row) => prisma.memberPaymentFlag.upsert(...))`:
    // cada upsert ya devuelve una promesa → simplemente las esperamos todas.
    async $transaction(operations: Array<Promise<unknown>>) {
      return Promise.all(operations);
    },
  };
}

const fakeAuditLog = {
  async record(_input: unknown) {
    /* noop */
  },
};

const fakeLogger = { warn: () => {}, log: () => {}, error: () => {}, debug: () => {} };

function makeService() {
  const prisma = makeFakePrisma();
  const service = new MemberPaymentFlagService(
    prisma as never,
    fakeAuditLog as never,
    fakeLogger as never,
  );
  return { service, prisma };
}

function dto(over: Partial<PaymentFlagUpsertDto> & { telegramId: string }): PaymentFlagUpsertDto {
  return { isDelinquent: true, ...over };
}

describe('MemberPaymentFlagService.upsert', () => {
  it('crea una fila nueva con la clave compuesta (tenantId, telegramId)', async () => {
    const { service, prisma } = makeService();
    const res = await service.upsert(
      TENANT_ID,
      dto({ telegramId: '111', name: 'Moroso A', isDelinquent: true, note: 'impago marzo' }),
      ACTOR_ID,
      CTX,
    );

    expect(res.id).toMatch(/^flag-/);
    expect(prisma.flags).toHaveLength(1);
    expect(prisma.flags[0]).toMatchObject({
      tenantId: TENANT_ID,
      telegramId: '111',
      name: 'Moroso A',
      isDelinquent: true,
      note: 'impago marzo',
    });
  });

  it('es idempotente: re-upsert sobre el mismo telegramId actualiza la fila existente', async () => {
    const { service, prisma } = makeService();
    const first = await service.upsert(
      TENANT_ID,
      dto({ telegramId: '111', isDelinquent: true }),
      ACTOR_ID,
      CTX,
    );
    const second = await service.upsert(
      TENANT_ID,
      dto({ telegramId: '111', isDelinquent: false, name: 'Ya pagó' }),
      ACTOR_ID,
      CTX,
    );

    expect(second.id).toBe(first.id);
    expect(prisma.flags).toHaveLength(1);
    expect(prisma.flags[0].isDelinquent).toBe(false);
    expect(prisma.flags[0].name).toBe('Ya pagó');
  });

  it('normaliza name y note ausentes a null', async () => {
    const { service, prisma } = makeService();
    await service.upsert(TENANT_ID, dto({ telegramId: '222' }), ACTOR_ID, CTX);
    expect(prisma.flags[0].name).toBeNull();
    expect(prisma.flags[0].note).toBeNull();
  });
});

describe('MemberPaymentFlagService.list', () => {
  it('solo devuelve filas del tenant indicado', async () => {
    const { service, prisma } = makeService();
    await service.upsert(TENANT_ID, dto({ telegramId: '111' }), ACTOR_ID, CTX);
    await service.upsert(OTHER_TENANT, dto({ telegramId: '222' }), ACTOR_ID, CTX);

    const rows = await service.list(TENANT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].telegramId).toBe('111');
    // La fila del otro tenant sigue persistida pero no se devuelve.
    expect(prisma.flags).toHaveLength(2);
  });

  it('con delinquentOnly filtra los no morosos', async () => {
    const { service } = makeService();
    await service.upsert(TENANT_ID, dto({ telegramId: '111', isDelinquent: true }), ACTOR_ID, CTX);
    await service.upsert(TENANT_ID, dto({ telegramId: '222', isDelinquent: false }), ACTOR_ID, CTX);

    const all = await service.list(TENANT_ID);
    const onlyDelinquent = await service.list(TENANT_ID, { delinquentOnly: true });
    expect(all).toHaveLength(2);
    expect(onlyDelinquent).toHaveLength(1);
    expect(onlyDelinquent[0].telegramId).toBe('111');
  });

  it('con q hace match parcial por telegramId o por name (case-insensitive)', async () => {
    const { service } = makeService();
    await service.upsert(TENANT_ID, dto({ telegramId: '12345', name: 'Carlos' }), ACTOR_ID, CTX);
    await service.upsert(TENANT_ID, dto({ telegramId: '67890', name: 'Marta' }), ACTOR_ID, CTX);

    const byId = await service.list(TENANT_ID, { q: '123' });
    expect(byId).toHaveLength(1);
    expect(byId[0].telegramId).toBe('12345');

    const byName = await service.list(TENANT_ID, { q: 'marta' });
    expect(byName).toHaveLength(1);
    expect(byName[0].name).toBe('Marta');
  });
});

describe('MemberPaymentFlagService.remove', () => {
  it('borra la fila por id filtrando por tenantId', async () => {
    const { service, prisma } = makeService();
    const created = await service.upsert(TENANT_ID, dto({ telegramId: '111' }), ACTOR_ID, CTX);
    await service.remove(TENANT_ID, created.id, ACTOR_ID);
    expect(prisma.flags).toHaveLength(0);
  });

  it('no borra una fila de otro tenant aunque el id coincida (anti borrado cruzado)', async () => {
    const { service, prisma } = makeService();
    const otherFlag = await service.upsert(OTHER_TENANT, dto({ telegramId: '999' }), ACTOR_ID, CTX);
    // Intentamos borrar el id del otro tenant pasando NUESTRO tenantId.
    await service.remove(TENANT_ID, otherFlag.id, ACTOR_ID);
    expect(prisma.flags).toHaveLength(1);
  });
});

describe('MemberPaymentFlagService.importCsv', () => {
  it('upserta N filas dentro de la transacción y devuelve { imported: N }', async () => {
    const { service, prisma } = makeService();
    const rows: PaymentFlagUpsertDto[] = [
      dto({ telegramId: '111', name: 'A' }),
      dto({ telegramId: '222', name: 'B' }),
      dto({ telegramId: '333', name: 'C', isDelinquent: false }),
    ];

    const res = await service.importCsv(TENANT_ID, rows, ACTOR_ID, CTX);
    expect(res).toEqual({ imported: 3 });
    expect(prisma.flags).toHaveLength(3);
    expect(prisma.flags.map((f) => f.telegramId).sort()).toEqual(['111', '222', '333']);
  });

  it('es idempotente sobre telegramId repetido entre import y datos previos', async () => {
    const { service, prisma } = makeService();
    await service.upsert(TENANT_ID, dto({ telegramId: '111', isDelinquent: true }), ACTOR_ID, CTX);

    const res = await service.importCsv(
      TENANT_ID,
      [dto({ telegramId: '111', isDelinquent: false }), dto({ telegramId: '222' })],
      ACTOR_ID,
      CTX,
    );

    // imported cuenta las filas del CSV, no las nuevas creadas.
    expect(res).toEqual({ imported: 2 });
    // 111 se actualizó (no duplicó) y 222 se creó → total 2 filas.
    expect(prisma.flags).toHaveLength(2);
    const updated = prisma.flags.find((f) => f.telegramId === '111');
    expect(updated?.isDelinquent).toBe(false);
  });
});

describe('MemberPaymentFlagService.lookup', () => {
  it('devuelve { isDelinquent, name } cuando hay flag registrado', async () => {
    const { service } = makeService();
    await service.upsert(
      TENANT_ID,
      dto({ telegramId: '111', name: 'Moroso', isDelinquent: true }),
      ACTOR_ID,
      CTX,
    );

    const res = await service.lookup(TENANT_ID, '111');
    expect(res).toEqual({ isDelinquent: true, name: 'Moroso' });
  });

  it('devuelve null cuando no hay flag para ese telegramId', async () => {
    const { service } = makeService();
    const res = await service.lookup(TENANT_ID, 'inexistente');
    expect(res).toBeNull();
  });

  it('no cruza tenants: un telegramId de otro tenant no aparece', async () => {
    const { service } = makeService();
    await service.upsert(OTHER_TENANT, dto({ telegramId: '111' }), ACTOR_ID, CTX);
    const res = await service.lookup(TENANT_ID, '111');
    expect(res).toBeNull();
  });
});
