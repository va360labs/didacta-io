import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_HANDLER_REPLAY_WINDOW_MS,
  PersistentEventBus,
  type EnqueueOutcome,
  type OutboxDispatcher,
  type OutboxJobRef,
} from '../src/modules/persistent-event-bus';
import { tenantContextStorage, type TenantContext } from '../src/tenancy/tenant-context.storage';

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
          processedAt?: Date | null;
          processingAttempts?: { increment: number };
          lastError?: string | null;
        };
      }): Promise<OutboxRow> {
        const row = rows.get(args.where.id);
        if (!row) throw new Error('not found');
        // `!== undefined` y no truthiness: el bus escribe `null` a propósito
        // (limpiar el error al procesar, reabrir la fila al re-entregar) y con
        // un `if (args.data.x)` esos writes se perderían y el fake mentiría.
        if (args.data.processedAt !== undefined) row.processedAt = args.data.processedAt;
        if (args.data.processingAttempts)
          row.processingAttempts += args.data.processingAttempts.increment;
        if (args.data.lastError !== undefined) row.lastError = args.data.lastError;
        return row;
      },
      async findMany(args: {
        where: {
          processedAt?: null | { not: null };
          eventName?: { in: string[] };
          lastError?: { startsWith: string };
          createdAt?: { gte: Date };
        };
        orderBy: { createdAt: 'asc' };
        take: number;
      }): Promise<OutboxRow[]> {
        const w = args.where;
        return [...rows.values()]
          .filter((r) => {
            if (w.processedAt === null && r.processedAt !== null) return false;
            if (w.processedAt && 'not' in w.processedAt && r.processedAt === null) return false;
            if (w.eventName && !w.eventName.in.includes(r.eventName)) return false;
            if (w.lastError && !(r.lastError ?? '').startsWith(w.lastError.startsWith))
              return false;
            if (w.createdAt && r.createdAt.getTime() < w.createdAt.gte.getTime()) return false;
            return true;
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, args.take);
      },
      async findUnique(args: { where: { id: bigint } }): Promise<OutboxRow | null> {
        return rows.get(args.where.id) ?? null;
      },
    },
    _rows: rows,
  };
  return prisma;
}

function makeFakeDispatcher(): OutboxDispatcher & {
  enqueued: bigint[];
  enabled: boolean;
  /** Qué contesta el encolado. `deduplicated` = BullMQ se lo tragó. */
  outcome: EnqueueOutcome;
} {
  const state = {
    enqueued: [] as bigint[],
    enabled: true,
    outcome: 'queued' as EnqueueOutcome,
    isEnabled() {
      return state.enabled;
    },
    async enqueue(ref: OutboxJobRef) {
      state.enqueued.push(ref.id);
      return state.outcome;
    },
  };
  return state;
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
    expect(row!.processedAt).toBeInstanceOf(Date);
    expect(row!.processingAttempts).toBe(0);
  });

  it('abre el contexto ALS del tenant del evento alrededor de los handlers (RLS F1)', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    let seen: TenantContext | undefined;
    bus.subscribe('rls.contexto', async () => {
      seen = tenantContextStorage.getStore();
    });

    await bus.publish(makeEvent('rls.contexto'));

    // El despacho corre bajo el tenant del EVENTO, sin gucApplied: la
    // extensión RLS envuelve las queries de los bridges query a query.
    expect(seen?.tenantId).toBe('t1');
    expect(seen?.gucApplied).toBeUndefined();
    expect(seen?.traceId).toMatch(/^outbox-/);
  });

  it('un evento sin subscribers NO queda igual que uno entregado con éxito', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    const handler = vi.fn(async () => {});
    bus.subscribe('con.handler', handler);

    await bus.publish(makeEvent('con.handler', {}, 'idem-ok'));
    await bus.publish(makeEvent('algo.suelto', {}, 'idem-huerfano'));

    const [entregado, huerfano] = [...prisma._rows.values()];

    // Ésta es LA aserción del arreglo: antes las dos filas eran idénticas
    // (processedAt puesto, attempts 0, lastError null) y perder un evento era
    // indistinguible de procesarlo.
    expect(entregado!.lastError).toBeNull();
    expect(huerfano!.lastError).toBe('NO_HANDLER: algo.suelto');
    expect(entregado!.lastError).not.toEqual(huerfano!.lastError);
  });

  it('el éxito limpia el lastError de un intento anterior (o el estado sería ambiguo)', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    const off = bus.subscribe('reintento', async () => {
      throw new Error('boom');
    });
    await bus.publish(makeEvent('reintento', {}, 'idem-limpia'));
    const row = [...prisma._rows.values()][0]!;
    expect(row.lastError).toContain('boom');

    off();
    bus.subscribe('reintento', async () => {});
    await bus.recoverPending();

    expect(row.processedAt).toBeInstanceOf(Date);
    // Sin esta limpieza, «processedAt puesto + lastError no nulo» significaría
    // a la vez «reintento que acabó bien» y «no llegó a nadie».
    expect(row.lastError).toBeNull();
  });

  it('avisa por log y por el observador cuando un evento no llega a nadie', async () => {
    const warn = vi.fn();
    const observer = { recordUndelivered: vi.fn() };
    const bus = new PersistentEventBus(
      prisma as never,
      { ...silentLogger, warn },
      undefined,
      observer,
    );

    await bus.publish(makeEvent('nadie.escucha', {}, 'idem-warn'));

    expect(observer.recordUndelivered).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('sin handlers'),
      expect.objectContaining({ event: 'nadie.escucha' }),
    );
  });

  it('el evento sin handler NO se re-encola en bucle en el barrido de pendientes', async () => {
    // Marcarlo como pendiente habría sido la otra opción de diseño, y rompía el
    // recovery: hay ~30 nombres de evento publicados sin ningún consumidor
    // (fundae.*, messaging.*, courses.course.created…). Con `take: 50` ordenado
    // por antigüedad, el barrido se quedaría atascado en ellos para siempre.
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    await bus.publish(makeEvent('nadie.escucha', {}, 'idem-nobucle'));

    const result = await bus.recoverPending();
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
  });

  describe('replayUndelivered — la parte recuperable', () => {
    it('re-entrega el evento en cuanto aparece el subscriber que faltaba', async () => {
      const bus = new PersistentEventBus(prisma as never, silentLogger);

      // Carrera de arranque: el evento se despacha ANTES de que el bridge se
      // suscriba. Con el comportamiento anterior esto se perdía para siempre.
      await bus.publish(makeEvent('billing.order.completed', { orderId: 'o1' }, 'idem-replay'));
      const row = [...prisma._rows.values()][0]!;
      expect(row.lastError).toBe('NO_HANDLER: billing.order.completed');

      const bridge = vi.fn(async (_event: unknown) => {});
      bus.subscribe('billing.order.completed', bridge);

      const result = await bus.replayUndelivered();

      expect(result.replayed).toBe(1);
      expect(bridge).toHaveBeenCalledOnce();
      expect(bridge.mock.calls[0]![0]).toMatchObject({
        name: 'billing.order.completed',
        data: { orderId: 'o1' },
      });
      expect(row.processedAt).toBeInstanceOf(Date);
      expect(row.lastError).toBeNull();
    });

    it('no re-entrega dos veces: tras el replay la fila ya no es elegible', async () => {
      const bus = new PersistentEventBus(prisma as never, silentLogger);
      await bus.publish(makeEvent('billing.order.completed', {}, 'idem-once'));
      const bridge = vi.fn(async (_event: unknown) => {});
      bus.subscribe('billing.order.completed', bridge);

      await bus.replayUndelivered();
      const second = await bus.replayUndelivered();

      expect(second.replayed).toBe(0);
      expect(bridge).toHaveBeenCalledOnce();
    });

    it('deja en paz los eventos que siguen sin tener a nadie suscrito', async () => {
      const bus = new PersistentEventBus(prisma as never, silentLogger);
      bus.subscribe('otro.evento', async () => {});
      await bus.publish(makeEvent('nadie.escucha', {}, 'idem-sigue-solo'));

      const result = await bus.replayUndelivered();

      expect(result.replayed).toBe(0);
      const row = [...prisma._rows.values()][0]!;
      expect(row.lastError).toBe('NO_HANDLER: nadie.escucha');
    });

    it('no re-entrega historia más vieja que la ventana', async () => {
      const bus = new PersistentEventBus(prisma as never, silentLogger);
      await bus.publish(makeEvent('billing.order.completed', {}, 'idem-viejo'));
      const row = [...prisma._rows.values()][0]!;
      // Envejecemos la fila más allá de la ventana: registrar un bridge nuevo
      // no puede desencadenar una re-entrega masiva de historia.
      row.createdAt = new Date(Date.now() - NO_HANDLER_REPLAY_WINDOW_MS - 60_000);

      const bridge = vi.fn(async (_event: unknown) => {});
      bus.subscribe('billing.order.completed', bridge);

      const result = await bus.replayUndelivered();
      expect(result.replayed).toBe(0);
      expect(bridge).not.toHaveBeenCalled();
    });

    it('si el handler del replay falla, la fila queda pendiente y reintentable', async () => {
      const bus = new PersistentEventBus(prisma as never, silentLogger);
      await bus.publish(makeEvent('billing.order.completed', {}, 'idem-replay-falla'));
      bus.subscribe('billing.order.completed', async () => {
        throw new Error('el bridge revienta');
      });

      const result = await bus.replayUndelivered();

      expect(result.failed).toBe(1);
      const row = [...prisma._rows.values()][0]!;
      // NO vuelve al estado NO_HANDLER: ahora es un fallo de despacho normal,
      // que `recoverPending` sí reintenta.
      expect(row.processedAt).toBeNull();
      expect(row.lastError).toContain('el bridge revienta');
      expect(row.processingAttempts).toBe(1);
    });
  });

  it('incrementa attempts y guarda lastError si el handler falla', async () => {
    const bus = new PersistentEventBus(prisma as never, silentLogger);
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    bus.subscribe('learning.course.completed', handler);

    await bus.publish(makeEvent('learning.course.completed'));

    const row = [...prisma._rows.values()][0];
    expect(row!.processedAt).toBeNull();
    expect(row!.processingAttempts).toBe(1);
    expect(row!.lastError).toContain('boom');
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
    expect(row!.processedAt).toBeInstanceOf(Date);
  });

  describe('con OutboxDispatcher async (BullMQ)', () => {
    it('publish encola en lugar de despachar in-process cuando dispatcher.enabled=true', async () => {
      const dispatcher = makeFakeDispatcher();
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      const handler = vi.fn(async () => {});
      bus.subscribe('learning.course.completed', handler);

      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-q'));

      expect(handler).not.toHaveBeenCalled(); // delegó a la queue
      expect(dispatcher.enqueued).toHaveLength(1);
      const row = [...prisma._rows.values()][0];
      expect(row!.processedAt).toBeNull(); // queda pendiente hasta que el worker lo procese
    });

    it('dispatcher.enabled=false hace fallback a in-process', async () => {
      const dispatcher = makeFakeDispatcher();
      dispatcher.enabled = false;
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      const handler = vi.fn(async () => {});
      bus.subscribe('learning.course.completed', handler);

      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-noq'));

      expect(handler).toHaveBeenCalledOnce();
      expect(dispatcher.enqueued).toHaveLength(0);
    });

    it('si enqueue falla, fallback a dispatch in-process (no perdemos el evento)', async () => {
      const dispatcher: OutboxDispatcher = {
        isEnabled: () => true,
        enqueue: async () => {
          throw new Error('redis caído');
        },
      };
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      const handler = vi.fn(async () => {});
      bus.subscribe('learning.course.completed', handler);

      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-fail'));

      expect(handler).toHaveBeenCalledOnce();
      const row = [...prisma._rows.values()][0];
      expect(row!.processedAt).toBeInstanceOf(Date);
    });

    it('processOutboxId ejecuta los handlers para una fila pendiente', async () => {
      const dispatcher = makeFakeDispatcher();
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      const handler = vi.fn(async () => {});
      bus.subscribe('learning.course.completed', handler);

      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-proc'));
      const row = [...prisma._rows.values()][0]!;
      expect(row.processedAt).toBeNull();

      // Simulamos al worker BullMQ levantando el job
      await bus.processOutboxId(row.id);

      expect(handler).toHaveBeenCalledOnce();
      expect(row.processedAt).toBeInstanceOf(Date);
    });

    it('processOutboxId es idempotente: no re-ejecuta si processedAt ya está', async () => {
      const dispatcher = makeFakeDispatcher();
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      const handler = vi.fn(async () => {});
      bus.subscribe('learning.course.completed', handler);

      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-i'));
      const row = [...prisma._rows.values()][0]!;
      await bus.processOutboxId(row.id);
      expect(handler).toHaveBeenCalledTimes(1);

      await bus.processOutboxId(row.id);
      expect(handler).toHaveBeenCalledTimes(1); // no se llamó de nuevo
    });

    it('processOutboxId lanza si los handlers fallan (BullMQ aplica backoff)', async () => {
      const dispatcher = makeFakeDispatcher();
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      bus.subscribe('learning.course.completed', async () => {
        throw new Error('boom');
      });

      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-throw'));
      const row = [...prisma._rows.values()][0]!;

      await expect(bus.processOutboxId(row.id)).rejects.toThrow(/outbox dispatch falló/);
      expect(row.processedAt).toBeNull();
      expect(row.processingAttempts).toBe(1);
    });

    it('processOutboxId NO lanza si no hay handlers, pero deja la fila etiquetada', async () => {
      const dispatcher = makeFakeDispatcher();
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);

      await bus.publish(makeEvent('nadie.escucha', {}, 'idem-nohandler-q'));
      const row = [...prisma._rows.values()][0]!;

      // Lanzar haría que BullMQ reintentara 5 veces con backoff CADA evento sin
      // consumidor. Reintentar contra un set de handlers vacío no arregla nada:
      // lo que lo arregla es que aparezca un subscriber, y de eso se ocupa
      // replayUndelivered.
      await expect(bus.processOutboxId(row!.id)).resolves.toBeUndefined();
      expect(row!.lastError).toBe('NO_HANDLER: nadie.escucha');
      expect(row!.processingAttempts).toBe(0);
    });

    it('recoverPending reencola pendientes a la queue (no despacha local)', async () => {
      const dispatcher = makeFakeDispatcher();
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      const handler = vi.fn(async () => {});
      bus.subscribe('learning.course.completed', handler);

      // Publicamos con dispatcher off (simulamos Redis caído al momento)
      dispatcher.enabled = false;
      bus.subscribe('learning.course.completed', async () => {
        throw new Error('first fail');
      });
      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-rec-q'));
      const row = [...prisma._rows.values()][0]!;
      expect(row.processedAt).toBeNull();

      // Ahora Redis vuelve, recoverPending debería reencolar (no procesar local)
      dispatcher.enabled = true;
      const result = await bus.recoverPending();
      expect(result.processed).toBe(1);
      expect(result.deduplicated).toBe(0);
      expect(dispatcher.enqueued).toEqual([row.id]);
    });

    it('recoverPending NO cuenta como procesado un re-enqueue deduplicado', async () => {
      // El failsafe reportando éxito sin entregar nada: `processed++` sobre un
      // `add` que BullMQ descartó contra un job terminal. La fila sigue
      // pendiente, el handler no corrió, y el sweep decía que todo bien.
      const dispatcher = makeFakeDispatcher();
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      const handler = vi.fn(async () => {});
      bus.subscribe('learning.course.completed', handler);

      dispatcher.enabled = false;
      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-dedup'));
      const row = [...prisma._rows.values()][0]!;
      row.processedAt = null; // pendiente, como si el despacho original no hubiera ido

      dispatcher.enabled = true;
      dispatcher.outcome = 'deduplicated';
      const result = await bus.recoverPending();

      expect(result.deduplicated).toBe(1);
      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
      // Y sigue pendiente: el próximo barrido lo vuelve a intentar.
      expect(row.processedAt).toBeNull();
    });

    it('publish cae a in-process si el enqueue quedó deduplicado', async () => {
      // `deduplicated` no es una excepción, así que sin desenlace explícito
      // publish() se daba por satisfecho y volvía. El evento no lo despachaba
      // nadie: ni la cola (job terminal) ni el proceso.
      const dispatcher = makeFakeDispatcher();
      dispatcher.outcome = 'deduplicated';
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      const handler = vi.fn(async () => {});
      bus.subscribe('learning.course.completed', handler);

      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-dedup-pub'));

      expect(dispatcher.enqueued).toHaveLength(1);
      expect(handler).toHaveBeenCalledOnce();
      const row = [...prisma._rows.values()][0];
      expect(row!.processedAt).toBeInstanceOf(Date);
    });

    it('el dispatcher recibe la fila entera, no sólo el id (createdAt es identidad)', async () => {
      // Si el bus siguiera pasando `row.id`, `buildOutboxJobId` no tendría de
      // dónde sacar el discriminante que sobrevive a recrear la base.
      const seen: OutboxJobRef[] = [];
      const dispatcher: OutboxDispatcher = {
        isEnabled: () => true,
        enqueue: async (ref) => {
          seen.push(ref);
          return 'queued';
        },
      };
      const bus = new PersistentEventBus(prisma as never, silentLogger, dispatcher);
      bus.subscribe(
        'learning.course.completed',
        vi.fn(async () => {}),
      );

      await bus.publish(makeEvent('learning.course.completed', {}, 'idem-ref'));

      expect(seen).toHaveLength(1);
      expect(seen[0]!.createdAt).toBeInstanceOf(Date);
      expect(seen[0]!.id).toBe([...prisma._rows.values()][0]!.id);
    });
  });
});
