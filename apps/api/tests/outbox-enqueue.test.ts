import { describe, expect, it, vi } from 'vitest';
import {
  buildOutboxJobId,
  enqueueOutboxJob,
  type OutboxJobHandle,
  type OutboxJobQueuePort,
} from '../src/modules/outbox-enqueue';

/**
 * Fake de la `Queue` de BullMQ que reproduce **la** conducta que causa el bug:
 * `add()` con un `jobId` que ya existe NO añade nada, devuelve el job
 * existente y no lo señala de ninguna forma.
 */
function makeFakeQueue(seed: Record<string, string> = {}): OutboxJobQueuePort & {
  jobs: Map<string, string>;
  adds: string[];
  removes: string[];
  removable: boolean;
} {
  const jobs = new Map<string, string>(Object.entries(seed));
  const fake = {
    jobs,
    adds: [] as string[],
    removes: [] as string[],
    /** false = el `remove` no consigue liberar el id (job bloqueado, etc.). */
    removable: true,
    async add(jobId: string): Promise<OutboxJobHandle> {
      fake.adds.push(jobId);
      if (!jobs.has(jobId)) jobs.set(jobId, 'waiting');
      return { getState: async () => jobs.get(jobId) ?? 'unknown' };
    },
    async remove(jobId: string): Promise<number> {
      fake.removes.push(jobId);
      if (!fake.removable) return 0;
      return jobs.delete(jobId) ? 1 : 0;
    },
  };
  return fake;
}

const ref = (id: bigint, createdAtMs: number) => ({ id, createdAt: new Date(createdAtMs) });

describe('buildOutboxJobId', () => {
  it('es determinista: la misma fila siempre produce el mismo jobId', () => {
    // Es lo que sostiene la deduplicación. Sin esto, publish() y el barrido de
    // recuperación encolarían dos jobs para el mismo evento.
    expect(buildOutboxJobId(ref(42n, 1_700_000_000_000))).toBe(
      buildOutboxJobId(ref(42n, 1_700_000_000_000)),
    );
  });

  it('base recreada: el mismo BIGSERIAL con otro createdAt NO reusa el jobId', () => {
    // El defecto entero. La secuencia vuelve a empezar en 1 y, con el id
    // pelado, el evento nuevo heredaba la identidad de un job ya completado en
    // Redis y BullMQ lo descartaba en silencio.
    const viejo = buildOutboxJobId(ref(1n, 1_700_000_000_000));
    const nuevo = buildOutboxJobId(ref(1n, 1_800_000_000_000));
    expect(nuevo).not.toBe(viejo);
  });

  it('no es un entero pelado (BullMQ rechaza custom ids enteros)', () => {
    const jobId = buildOutboxJobId(ref(7n, 1_700_000_000_000));
    expect(Number.isNaN(Number(jobId))).toBe(true);
    expect(jobId).toContain('7');
  });
});

describe('enqueueOutboxJob', () => {
  it('id libre: encola y devuelve queued', async () => {
    const queue = makeFakeQueue();
    const report = { onReplaced: vi.fn(), onSwallowed: vi.fn() };

    const outcome = await enqueueOutboxJob(queue, ref(1n, 1_700_000_000_000), report);

    expect(outcome).toBe('queued');
    expect(queue.adds).toHaveLength(1);
    expect(queue.removes).toHaveLength(0);
    expect(report.onReplaced).not.toHaveBeenCalled();
    expect(report.onSwallowed).not.toHaveBeenCalled();
  });

  it('dedup contra un job que TODAVÍA va a correr cuenta como queued', async () => {
    // Este dedup es el bueno: el evento se entregará por el job que ya estaba.
    // Reencolar aquí sería duplicar el despacho.
    const jobId = buildOutboxJobId(ref(1n, 1_700_000_000_000));
    const queue = makeFakeQueue({ [jobId]: 'active' });

    const outcome = await enqueueOutboxJob(queue, ref(1n, 1_700_000_000_000));

    expect(outcome).toBe('queued');
    expect(queue.removes).toHaveLength(0); // no se toca un job en vuelo
  });

  it.each(['completed', 'failed', 'unknown'])(
    'job terminal en estado %s: lo retira, reencola y avisa (replaced)',
    async (estado) => {
      // El caso que deja al failsafe inútil: un job que agotó sus 5 intentos
      // sigue 7 días en el set de fallidos y se traga todo reintento.
      const jobId = buildOutboxJobId(ref(9n, 1_700_000_000_000));
      const queue = makeFakeQueue({ [jobId]: estado });
      const report = { onReplaced: vi.fn(), onSwallowed: vi.fn() };

      const outcome = await enqueueOutboxJob(queue, ref(9n, 1_700_000_000_000), report);

      expect(outcome).toBe('queued');
      expect(queue.removes).toEqual([jobId]);
      expect(queue.adds).toEqual([jobId, jobId]);
      expect(queue.jobs.get(jobId)).toBe('waiting'); // hay job de verdad
      expect(report.onReplaced).toHaveBeenCalledWith(jobId);
      expect(report.onSwallowed).not.toHaveBeenCalled();
    },
  );

  it('si el id sigue ocupado tras el remove devuelve deduplicated (swallowed)', async () => {
    const jobId = buildOutboxJobId(ref(3n, 1_700_000_000_000));
    const queue = makeFakeQueue({ [jobId]: 'failed' });
    queue.removable = false; // el remove no libera la clave
    const report = { onReplaced: vi.fn(), onSwallowed: vi.fn() };

    const outcome = await enqueueOutboxJob(queue, ref(3n, 1_700_000_000_000), report);

    expect(outcome).toBe('deduplicated');
    expect(report.onSwallowed).toHaveBeenCalledWith(jobId);
    expect(report.onReplaced).not.toHaveBeenCalled();
  });

  it('un remove que lanza no rompe el encolado: se intenta el add igualmente', async () => {
    const jobId = buildOutboxJobId(ref(4n, 1_700_000_000_000));
    const queue = makeFakeQueue({ [jobId]: 'completed' });
    const boom = vi.fn(async () => {
      throw new Error('job locked');
    });
    const report = { onReplaced: vi.fn(), onSwallowed: vi.fn() };

    const outcome = await enqueueOutboxJob(
      { add: queue.add, remove: boom },
      ref(4n, 1_700_000_000_000),
      report,
    );

    expect(boom).toHaveBeenCalledOnce();
    // El id sigue ocupado por el job completado -> no se despachará.
    expect(outcome).toBe('deduplicated');
    expect(report.onSwallowed).toHaveBeenCalledWith(jobId);
  });
});
