/**
 * Tests de `MemberPaymentFlagService` (gestión admin de impagos —
 * mod_member_registration_payment_flag — que alimenta la validación manual).
 *
 * Desde F2.3 la clave de negocio es el EMAIL (con user_id vinculado si se
 * resuelve) y telegramId queda como clave legacy. Cubre:
 *  - upsert: crea por email (vinculando user_id), es idempotente por email,
 *    migra filas legacy (match por telegramId + email nuevo) y sigue
 *    aceptando la clave legacy sola.
 *  - list: filtra por tenantId (+ delinquentOnly, + q por email/telegram/name).
 *  - remove: borra vía deleteMany filtrando por tenantId (sin borrados cruzados).
 *  - importCsv: aplica la lógica de upsert por fila dentro de la transacción.
 *  - lookup por identidad: email primero, fallback telegram, aislado por tenant.
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
  email: string | null;
  userId: string | null;
  telegramId: string | null;
  name: string | null;
  isDelinquent: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  tenantId: string;
  email: string;
}

function makeFakePrisma(users: UserRow[] = []) {
  const flags: FlagRow[] = [];
  let autoId = 1;

  const memberPaymentFlag = {
    async findUnique(args: {
      where: {
        tenantId_email?: { tenantId: string; email: string };
        tenantId_telegramId?: { tenantId: string; telegramId: string };
      };
      select?: Partial<Record<keyof FlagRow, true>>;
    }) {
      let row: FlagRow | null = null;
      if (args.where.tenantId_email) {
        const { tenantId, email } = args.where.tenantId_email;
        row = flags.find((f) => f.tenantId === tenantId && f.email === email) ?? null;
      } else if (args.where.tenantId_telegramId) {
        const { tenantId, telegramId } = args.where.tenantId_telegramId;
        row = flags.find((f) => f.tenantId === tenantId && f.telegramId === telegramId) ?? null;
      }
      if (!row) return null;
      // Proyección del select, como el Prisma real.
      if (!args.select) return row;
      const projected: Record<string, unknown> = {};
      for (const key of Object.keys(args.select) as Array<keyof FlagRow>) {
        if (args.select[key]) projected[key] = row[key];
      }
      return projected;
    },
    async updateMany(args: {
      where: { tenantId: string; id: string };
      data: Partial<Omit<FlagRow, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>>;
    }) {
      let count = 0;
      for (const f of flags) {
        if (f.tenantId === args.where.tenantId && f.id === args.where.id) {
          Object.assign(f, args.data, { updatedAt: new Date() });
          count++;
        }
      }
      return { count };
    },
    async create(args: {
      data: Omit<FlagRow, 'id' | 'createdAt' | 'updatedAt'>;
      select?: { id: true };
    }) {
      const row: FlagRow = {
        id: `flag-${autoId++}`,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      flags.push(row);
      return { id: row.id };
    },
    async findMany(args: {
      where: {
        tenantId: string;
        isDelinquent?: boolean;
        OR?: Array<
          | { email: { contains: string; mode: 'insensitive' } }
          | { telegramId: { contains: string } }
          | { name: { contains: string; mode: 'insensitive' } }
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
            if ('email' in cond) {
              return (f.email ?? '').toLowerCase().includes(cond.email.contains.toLowerCase());
            }
            if ('telegramId' in cond) {
              return (f.telegramId ?? '').includes(cond.telegramId.contains);
            }
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
  };

  const user = {
    async findUnique(args: {
      where: { tenantId_email: { tenantId: string; email: string } };
      select: { id: true };
    }) {
      const { tenantId, email } = args.where.tenantId_email;
      const u = users.find((x) => x.tenantId === tenantId && x.email === email);
      return u ? { id: u.id } : null;
    },
  };

  const client = { memberPaymentFlag, user };

  return {
    flags,
    memberPaymentFlag,
    user,
    // El service usa la forma interactiva: $transaction(async (tx) => {...}).
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>, _opts?: unknown): Promise<T> {
      return fn(client);
    },
  };
}

const fakeAuditLog = {
  async record(_input: unknown) {
    /* noop */
  },
};

const fakeLogger = { warn: () => {}, log: () => {}, error: () => {}, debug: () => {} };

function makeService(users: UserRow[] = []) {
  const prisma = makeFakePrisma(users);
  const service = new MemberPaymentFlagService(
    prisma as never,
    fakeAuditLog as never,
    fakeLogger as never,
  );
  return { service, prisma };
}

function dto(over: Partial<PaymentFlagUpsertDto>): PaymentFlagUpsertDto {
  return { isDelinquent: true, ...over } as PaymentFlagUpsertDto;
}

describe('MemberPaymentFlagService.upsert', () => {
  it('crea una fila por email y vincula el user_id del tenant si existe', async () => {
    const { service, prisma } = makeService([
      { id: 'user-9', tenantId: TENANT_ID, email: 'moroso@example.com' },
    ]);
    const res = await service.upsert(
      TENANT_ID,
      dto({ email: 'moroso@example.com', name: 'Moroso A', note: 'impago marzo' }),
      ACTOR_ID,
      CTX,
    );

    expect(res.id).toMatch(/^flag-/);
    expect(prisma.flags).toHaveLength(1);
    expect(prisma.flags[0]).toMatchObject({
      tenantId: TENANT_ID,
      email: 'moroso@example.com',
      userId: 'user-9',
      telegramId: null,
      name: 'Moroso A',
      isDelinquent: true,
      note: 'impago marzo',
    });
  });

  it('normaliza el email a minúsculas y sin espacios', async () => {
    const { service, prisma } = makeService();
    await service.upsert(TENANT_ID, dto({ email: ' Moroso@Example.com ' }), ACTOR_ID, CTX);
    expect(prisma.flags[0].email).toBe('moroso@example.com');
  });

  it('es idempotente por email: re-upsert actualiza la fila existente', async () => {
    const { service, prisma } = makeService();
    const first = await service.upsert(
      TENANT_ID,
      dto({ email: 'a@example.com', isDelinquent: true }),
      ACTOR_ID,
      CTX,
    );
    const second = await service.upsert(
      TENANT_ID,
      dto({ email: 'a@example.com', isDelinquent: false, name: 'Ya pagó' }),
      ACTOR_ID,
      CTX,
    );

    expect(second.id).toBe(first.id);
    expect(prisma.flags).toHaveLength(1);
    expect(prisma.flags[0].isDelinquent).toBe(false);
    expect(prisma.flags[0].name).toBe('Ya pagó');
  });

  it('migra una fila legacy: match por telegramId y adopción del email nuevo', async () => {
    const { service, prisma } = makeService([
      { id: 'user-7', tenantId: TENANT_ID, email: 'legacy@example.com' },
    ]);
    const legacy = await service.upsert(TENANT_ID, dto({ telegramId: '111' }), ACTOR_ID, CTX);

    const migrated = await service.upsert(
      TENANT_ID,
      dto({ email: 'legacy@example.com', telegramId: '111', isDelinquent: false }),
      ACTOR_ID,
      CTX,
    );

    // Misma fila (no duplica), ahora clavada al email y con el user vinculado.
    expect(migrated.id).toBe(legacy.id);
    expect(prisma.flags).toHaveLength(1);
    expect(prisma.flags[0]).toMatchObject({
      email: 'legacy@example.com',
      userId: 'user-7',
      telegramId: '111',
      isDelinquent: false,
    });
  });

  it('clave legacy sola (telegramId) sigue funcionando', async () => {
    const { service, prisma } = makeService();
    await service.upsert(TENANT_ID, dto({ telegramId: '222' }), ACTOR_ID, CTX);
    expect(prisma.flags[0]).toMatchObject({ telegramId: '222', email: null, userId: null });
  });

  it('normaliza name y note ausentes a null', async () => {
    const { service, prisma } = makeService();
    await service.upsert(TENANT_ID, dto({ email: 'x@example.com' }), ACTOR_ID, CTX);
    expect(prisma.flags[0].name).toBeNull();
    expect(prisma.flags[0].note).toBeNull();
  });
});

describe('MemberPaymentFlagService.list', () => {
  it('solo devuelve filas del tenant indicado', async () => {
    const { service, prisma } = makeService();
    await service.upsert(TENANT_ID, dto({ email: 'a@example.com' }), ACTOR_ID, CTX);
    await service.upsert(OTHER_TENANT, dto({ email: 'b@example.com' }), ACTOR_ID, CTX);

    const rows = await service.list(TENANT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('a@example.com');
    // La fila del otro tenant sigue persistida pero no se devuelve.
    expect(prisma.flags).toHaveLength(2);
  });

  it('con delinquentOnly filtra los no morosos', async () => {
    const { service } = makeService();
    await service.upsert(
      TENANT_ID,
      dto({ email: 'a@example.com', isDelinquent: true }),
      ACTOR_ID,
      CTX,
    );
    await service.upsert(
      TENANT_ID,
      dto({ email: 'b@example.com', isDelinquent: false }),
      ACTOR_ID,
      CTX,
    );

    const all = await service.list(TENANT_ID);
    const onlyDelinquent = await service.list(TENANT_ID, { delinquentOnly: true });
    expect(all).toHaveLength(2);
    expect(onlyDelinquent).toHaveLength(1);
    expect(onlyDelinquent[0].email).toBe('a@example.com');
  });

  it('con q hace match parcial por email, telegramId o name (case-insensitive)', async () => {
    const { service } = makeService();
    await service.upsert(
      TENANT_ID,
      dto({ email: 'carlos@example.com', telegramId: '12345', name: 'Carlos' }),
      ACTOR_ID,
      CTX,
    );
    await service.upsert(
      TENANT_ID,
      dto({ email: 'marta@example.com', name: 'Marta' }),
      ACTOR_ID,
      CTX,
    );

    const byId = await service.list(TENANT_ID, { q: '123' });
    expect(byId).toHaveLength(1);
    expect(byId[0].telegramId).toBe('12345');

    const byName = await service.list(TENANT_ID, { q: 'marta' });
    expect(byName).toHaveLength(1);
    expect(byName[0].name).toBe('Marta');

    const byEmail = await service.list(TENANT_ID, { q: 'CARLOS@EX' });
    expect(byEmail).toHaveLength(1);
    expect(byEmail[0].email).toBe('carlos@example.com');
  });
});

describe('MemberPaymentFlagService.remove', () => {
  it('borra la fila por id filtrando por tenantId', async () => {
    const { service, prisma } = makeService();
    const created = await service.upsert(TENANT_ID, dto({ email: 'a@example.com' }), ACTOR_ID, CTX);
    await service.remove(TENANT_ID, created.id, ACTOR_ID);
    expect(prisma.flags).toHaveLength(0);
  });

  it('no borra una fila de otro tenant aunque el id coincida (anti borrado cruzado)', async () => {
    const { service, prisma } = makeService();
    const otherFlag = await service.upsert(
      OTHER_TENANT,
      dto({ email: 'z@example.com' }),
      ACTOR_ID,
      CTX,
    );
    // Intentamos borrar el id del otro tenant pasando NUESTRO tenantId.
    await service.remove(TENANT_ID, otherFlag.id, ACTOR_ID);
    expect(prisma.flags).toHaveLength(1);
  });
});

describe('MemberPaymentFlagService.importCsv', () => {
  it('importa filas por email y por telegramId (export de Telegram) y devuelve { imported: N }', async () => {
    const { service, prisma } = makeService();
    const rows: PaymentFlagUpsertDto[] = [
      dto({ email: 'a@example.com', name: 'A' }),
      dto({ telegramId: '222', name: 'B' }),
      dto({ email: 'c@example.com', name: 'C', isDelinquent: false }),
    ];

    const res = await service.importCsv(TENANT_ID, rows, ACTOR_ID, CTX);
    expect(res).toEqual({ imported: 3 });
    expect(prisma.flags).toHaveLength(3);
  });

  it('es idempotente sobre claves repetidas entre import y datos previos', async () => {
    const { service, prisma } = makeService();
    await service.upsert(
      TENANT_ID,
      dto({ email: 'a@example.com', isDelinquent: true }),
      ACTOR_ID,
      CTX,
    );

    const res = await service.importCsv(
      TENANT_ID,
      [dto({ email: 'a@example.com', isDelinquent: false }), dto({ telegramId: '222' })],
      ACTOR_ID,
      CTX,
    );

    // imported cuenta las filas del CSV, no las nuevas creadas.
    expect(res).toEqual({ imported: 2 });
    // a@example.com se actualizó (no duplicó) y 222 se creó → total 2 filas.
    expect(prisma.flags).toHaveLength(2);
    const updated = prisma.flags.find((f) => f.email === 'a@example.com');
    expect(updated?.isDelinquent).toBe(false);
  });
});

describe('MemberPaymentFlagService.lookup', () => {
  it('matchea por email (clave principal)', async () => {
    const { service } = makeService();
    await service.upsert(
      TENANT_ID,
      dto({ email: 'moroso@example.com', name: 'Moroso' }),
      ACTOR_ID,
      CTX,
    );

    const res = await service.lookup(TENANT_ID, { email: 'Moroso@Example.com' });
    expect(res).toEqual({ isDelinquent: true, name: 'Moroso' });
  });

  it('cae a la clave legacy por telegramId cuando el email no matchea', async () => {
    const { service } = makeService();
    await service.upsert(TENANT_ID, dto({ telegramId: '111', name: 'Legacy' }), ACTOR_ID, CTX);

    const res = await service.lookup(TENANT_ID, {
      email: 'sin-flag@example.com',
      telegramId: '111',
    });
    expect(res).toEqual({ isDelinquent: true, name: 'Legacy' });
  });

  it('devuelve null cuando ninguna clave matchea', async () => {
    const { service } = makeService();
    const res = await service.lookup(TENANT_ID, { email: 'nadie@example.com', telegramId: '404' });
    expect(res).toBeNull();
  });

  it('no cruza tenants: la identidad de otro tenant no aparece', async () => {
    const { service } = makeService();
    await service.upsert(OTHER_TENANT, dto({ email: 'a@example.com' }), ACTOR_ID, CTX);
    const res = await service.lookup(TENANT_ID, { email: 'a@example.com' });
    expect(res).toBeNull();
  });
});
