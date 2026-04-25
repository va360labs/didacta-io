import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistentEventBus } from '../src/modules/persistent-event-bus';

interface OutboxRow {
  id: bigint;
  tenantId: string;
  eventName: string;
  payloadVersion: number;
  payload: unknown;
  metadata: { tenantId: string; idempotencyKey: string; timestamp: string; traceId: string };
  idempotencyKey: string;
  processedAt: Date | null;
  processingAttempts: number;
  lastError: string | null;
  createdAt: Date;
}

function makeFakePrisma() {
  const rows = new Map<bigint, OutboxRow>();
  let nextId = 1n;

  const prisma = {
    outboxEvent: {
      async upsert(args: {
        where: { tenantId_idempotencyKey: { tenantId: string; idempotencyKey: string } };
        create: Omit<
          OutboxRow,
          'id' | 'processedAt' | 'processingAttempts' | 'lastError' | 'createdAt'
        >;
      }): Promise<OutboxRow> {
        const existing = [...rows.values()].find(
          (r) =>
            r.tenantId === args.where.tenantId_idempotencyKey.tenantId &&
            r.idempotencyKey === args.where.tenantId_idempotencyKey.idempotencyKey,
        );
        if (existing) return existing;
        const id = nextId++;
        const row: OutboxRow = {
          id,
          tenantId: args.create.tenantId,
          eventName: args.create.eventName,
          payloadVersion: args.create.payloadVersion,
          payload: args.create.payload,
          metadata: args.create.metadata,
          idempotencyKey: args.create.idempotencyKey,
          processedAt: null,
          processingAttempts: 0,
          lastError: null,
          createdAt: new Date(),
        };
        rows.set(id, row);
        return row;
      },
      async update(args: {
        where: { id: bigint };
        data: {
          processedAt?: Date;
          processingAttempts?: { increment: number };
          lastError?: string;
        };
      }): Promise<OutboxRow> {
        const row = rows.get(args.where.id);
        if (!row) throw new Error('not found');
        if (args.data.processedAt) row.processedAt = args.data.processedAt;
        if (args.data.processingAttempts)
          row.processingAttempts += args.data.processingAttempts.increment;
        if (typeof args.data.lastError === 'string') row.lastError = args.data.lastError;
        return row;
      },
      async findMany(args: {
        where: { processedAt: null };
        orderBy: { createdAt: 'asc' };
        take: number;
      }): Promise<OutboxRow[]> {
        const _ = args;
        return [...rows.values()]
          .filter((r) => r.processedAt === null)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
    },
    _rows: rows,
  };
  return prisma;
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

function makeEvent(name: string, data: Record<string, unknown> = {}, idemKey?: string) {
  return {
    name,
    version: 1,
    data,
    metadata: {
      tenantId: 't1',
      timestamp: new Date().toISOString(),
      traceId: 'trace-1',
      idempotencyKey: idemKey ?? `${name}:${Math.random()}`,
    },
  };
}

describe('PersistentEventBus', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  beforeEach(() => {
    prisma = makeFakePrisma();
  });

  it('persiste el evento y despacha al handler local', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    const handler = vi.fn(async () => {});
    bus.subscribe('learning.course.completed', handler);

    await bus.publish(makeEvent('learning.course.completed', { enrollmentId: 'e1' }));

    expect(handler).toHaveBeenCalledOnce();
    const row = [...prisma._rows.values()][0];
    expect(row.processedAt).toBeInstanceOf(Date);
    expect(row.processingAttempts).toBe(0);
  });

  it('marca processedAt aunque no haya subscribers (no se pierde el evento)', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    await bus.publish(makeEvent('algo.suelto'));
    const row = [...prisma._rows.values()][0];
    expect(row.processedAt).toBeInstanceOf(Date);
  });

  it('incrementa attempts y guarda lastError si el handler falla', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    bus.subscribe('learning.course.completed', handler);

    await bus.publish(makeEvent('learning.course.completed'));

    const row = [...prisma._rows.values()][0];
    expect(row.processedAt).toBeNull();
    expect(row.processingAttempts).toBe(1);
    expect(row.lastError).toContain('boom');
  });

  it('upsert por idempotencyKey: no duplica si llega el mismo evento dos veces', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    const handler = vi.fn(async () => {});
    bus.subscribe('learning.course.completed', handler);

    const event = makeEvent('learning.course.completed', {}, 'idem-1');
    await bus.publish(event);
    await bus.publish(event);

    expect(prisma._rows.size).toBe(1);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('recoverPending reprocesa eventos con processedAt=null', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);

    // publicamos sin handler -> queda procesado igualmente (sin subscribers)
    // así que para simular un fallo, registramos un handler que falla.
    const failing = vi.fn(async () => {
      throw new Error('first fail');
    });
    const off = bus.subscribe('learning.course.completed', failing);
    await bus.publish(makeEvent('learning.course.completed', {}, 'idem-recover'));

    // El primer despacho falló. Ahora cambiamos por un handler que pasa.
    off();
    const ok = vi.fn(async () => {});
    bus.subscribe('learning.course.completed', ok);

    const result = await bus.recoverPending();
    expect(result.processed).toBe(1);
    expect(ok).toHaveBeenCalledOnce();
    const row = [...prisma._rows.values()][0];
    expect(row.processedAt).toBeInstanceOf(Date);
  });
});
