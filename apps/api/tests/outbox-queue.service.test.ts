import { describe, expect, it } from 'vitest';
import { OutboxQueueService } from '../src/modules/outbox-queue.service';

/**
 * `countWorkers()` responde a la pregunta «¿cuántos procesos están consumiendo
 * esta cola?», que es la que distingue un bus sano de uno en el que otro
 * proceso se está llevando la mitad de los eventos sin que nadie se entere.
 */
describe('OutboxQueueService.countWorkers', () => {
  function makeService(): OutboxQueueService {
    const factory = { getEventBus: () => ({}) };
    const logger = { log() {}, warn() {}, error() {}, debug() {} };
    const metrics = {
      recordDispatchDuration() {},
      recordDispatchFailed() {},
      recordDispatchCompleted() {},
      recordEnqueueCollision() {},
    };
    return new OutboxQueueService(factory as never, logger as never, metrics as never);
  }

  it('devuelve 0 sin cola inicializada en vez de reventar', async () => {
    // Sin REDIS_URL el dispatcher no se monta. Cero es la respuesta honesta —
    // «no hay nadie despachando»— y es justo lo que el arnés convierte en un
    // fallo con nombre: un 0 aquí significa que los eventos se van a quedar
    // pendientes para siempre.
    expect(await makeService().countWorkers()).toBe(0);
  });

  it('cuenta los workers que BullMQ ve atados a la cola', async () => {
    const service = makeService();
    // La cola es privada a propósito (nadie de fuera debe encolar sin pasar por
    // `enqueue`), así que el doble se inyecta como lo haría el bootstrap.
    (service as unknown as { queue: { getWorkers: () => Promise<unknown[]> } }).queue = {
      getWorkers: async () => [{ id: 'a' }, { id: 'b' }],
    };
    expect(await service.countWorkers()).toBe(2);
  });
});
