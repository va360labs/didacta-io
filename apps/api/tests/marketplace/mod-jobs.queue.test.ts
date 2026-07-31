import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOD_JOBS_QUEUE_NAME,
  ModJobsQueueService,
  type ModJobPayload,
} from '../../src/marketplace/job-runner/mod-jobs.queue';

/// Tests del ModJobsQueueService (Sprint 3 / JR-001).
///
/// Mockeamos `bullmq` y `ioredis` para evitar dependencia de Redis real.
/// El patrón es el mismo que usan otros tests del marketplace que mockean
/// I/O externa.

// ─────────────────────────────────────────────────────────────────────────────
// Mocks de bullmq + ioredis
// ─────────────────────────────────────────────────────────────────────────────

const queueAdd = vi.fn(async () => ({ id: 'job-id' }));
const queueClose = vi.fn(async () => undefined);

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: queueAdd,
    close: queueClose,
  })),
}));

const redisPing = vi.fn(async () => 'PONG');
const redisQuit = vi.fn(async () => undefined);

vi.mock('ioredis', () => {
  const Ctor = vi.fn().mockImplementation(() => ({
    ping: redisPing,
    quit: redisQuit,
  }));
  return { default: Ctor };
});

// Logger stub: el service inyecta `Logger` de nestjs-pino.
function makeLoggerStub() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('nestjs-pino').Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

let originalRedisUrl: string | undefined;
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalRedisUrl = process.env['REDIS_URL'];
  originalNodeEnv = process.env['NODE_ENV'];
  queueAdd.mockClear();
  queueClose.mockClear();
  redisPing.mockClear();
  redisQuit.mockClear();
});

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env['REDIS_URL'];
  else process.env['REDIS_URL'] = originalRedisUrl;
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = originalNodeEnv;
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsQueueService — bootstrap', () => {
  it('NO inicializa la queue si REDIS_URL está ausente', async () => {
    delete process.env['REDIS_URL'];
    process.env['NODE_ENV'] = 'production';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();
    expect(svc.isEnabled()).toBe(false);
  });

  it('NO inicializa la queue en NODE_ENV=test (consistente con outbox)', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'test';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();
    expect(svc.isEnabled()).toBe(false);
  });

  it('inicializa la queue cuando REDIS_URL está y NODE_ENV != test', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'production';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();
    expect(svc.isEnabled()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enqueue
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsQueueService.enqueue', () => {
  it('lanza error si la queue no está inicializada', async () => {
    delete process.env['REDIS_URL'];
    process.env['NODE_ENV'] = 'production';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();

    const payload: ModJobPayload = {
      moduleName: 'mod.test',
      jobId: 'job-123',
      tenantId: 'tenant-456',
      tickIndex: 0,
    };
    await expect(svc.enqueue(payload)).rejects.toThrow(/no inicializada/i);
  });

  it('encola con jobId único derivado de (module, job, tickIndex)', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'production';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();

    const payload: ModJobPayload = {
      moduleName: 'mod.test',
      jobId: 'job-123',
      tenantId: 'tenant-456',
      tickIndex: 7,
    };
    await svc.enqueue(payload);
    expect(queueAdd).toHaveBeenCalledWith(
      'tick',
      payload,
      expect.objectContaining({ jobId: 'mod.test:job-123:7' }),
    );
  });

  it('aplica delay en milisegundos cuando se pasa delaySec', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'production';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();

    await svc.enqueue(
      {
        moduleName: 'mod.test',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        tickIndex: 0,
      },
      { delaySec: 30 },
    );
    expect(queueAdd).toHaveBeenCalledWith(
      'tick',
      expect.any(Object),
      expect.objectContaining({ delay: 30_000 }),
    );
  });

  it('no aplica delay cuando delaySec=0', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'production';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();

    await svc.enqueue(
      {
        moduleName: 'mod.test',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        tickIndex: 0,
      },
      { delaySec: 0 },
    );
    const opts = queueAdd.mock.calls[0]![2] as { delay?: number };
    expect(opts.delay).toBeUndefined();
  });

  it('jobId es único por (module, job, tickIndex) — distintos ticks generan keys distintas', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'production';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();

    await svc.enqueue({
      moduleName: 'mod.x',
      jobId: 'j',
      tenantId: 't',
      tickIndex: 0,
    });
    await svc.enqueue({
      moduleName: 'mod.x',
      jobId: 'j',
      tenantId: 't',
      tickIndex: 1,
    });
    const ids = queueAdd.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(ids).toEqual(['mod.x:j:0', 'mod.x:j:1']);
    expect(new Set(ids).size).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ping & teardown
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsQueueService — health', () => {
  it('ping devuelve true cuando Redis contesta PONG', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'production';
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();
    redisPing.mockResolvedValueOnce('PONG');
    await expect(svc.ping()).resolves.toBe(true);
  });

  it('ping devuelve false si la queue no se inicializó', async () => {
    delete process.env['REDIS_URL'];
    const svc = new ModJobsQueueService(makeLoggerStub());
    await svc.onApplicationBootstrap();
    await expect(svc.ping()).resolves.toBe(false);
  });

  it('queue name es el canónico', () => {
    expect(MOD_JOBS_QUEUE_NAME).toBe('didacta.mod-jobs');
  });
});
