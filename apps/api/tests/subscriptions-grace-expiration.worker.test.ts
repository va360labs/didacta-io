import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionsGraceExpirationWorker } from '../src/modules/subscriptions-grace-expiration.worker';

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function buildRegistryStub(opts: { initialized?: boolean; expired?: unknown[] } = {}) {
  const expireGracePeriods = vi.fn(async () => opts.expired ?? []);
  const service = { expireGracePeriods };
  const registry = {
    getSubscriptionsService: vi.fn(() => {
      if (opts.initialized === false) {
        throw new Error('mod.subscriptions no está inicializado.');
      }
      return service;
    }),
  } as never;
  return { registry, service, expireGracePeriods };
}

describe('SubscriptionsGraceExpirationWorker.triggerNow (degraded mode, sin Redis)', () => {
  const originalRedisUrl = process.env['REDIS_URL'];

  beforeEach(() => {
    // Aseguramos que NO hay Redis: el worker NO arrancará la queue real,
    // y triggerNow() ejecutará in-process.
    delete process.env['REDIS_URL'];
  });

  afterEach(() => {
    if (originalRedisUrl !== undefined) {
      process.env['REDIS_URL'] = originalRedisUrl;
    }
  });

  it('invoca expireGracePeriods() del SubscriptionsService cuando se llama triggerNow()', async () => {
    const { registry, expireGracePeriods } = buildRegistryStub({
      expired: [
        {
          id: 's1',
          tenantId: 't1',
          userId: 'u1',
          courseId: 'c1',
          status: 'UNPAID',
        },
      ],
    });

    const worker = new SubscriptionsGraceExpirationWorker(registry, noopLogger);

    // Sin onApplicationBootstrap (no Redis). triggerNow debe degradar a in-process.
    await worker.triggerNow();

    expect(registry.getSubscriptionsService).toHaveBeenCalledTimes(1);
    expect(expireGracePeriods).toHaveBeenCalledTimes(1);
  });

  it('si mod.subscriptions no está inicializado, loguea warn y NO lanza', async () => {
    const { registry } = buildRegistryStub({ initialized: false });
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never;

    const worker = new SubscriptionsGraceExpirationWorker(registry, logger);

    await expect(worker.triggerNow()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    // El warn debe mencionar que el módulo no está inicializado
    const warnArgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(warnArgs)).toContain('no inicializado');
  });

  it('si expireGracePeriods() lanza, el worker re-lanza (para retry de BullMQ)', async () => {
    const expireGracePeriods = vi.fn(async () => {
      throw new Error('boom');
    });
    const registry = {
      getSubscriptionsService: vi.fn(() => ({ expireGracePeriods })),
    } as never;

    const worker = new SubscriptionsGraceExpirationWorker(registry, noopLogger);

    await expect(worker.triggerNow()).rejects.toThrow('boom');
    expect(expireGracePeriods).toHaveBeenCalledTimes(1);
  });
});

describe('SubscriptionsGraceExpirationWorker.onApplicationBootstrap', () => {
  const originalRedisUrl = process.env['REDIS_URL'];
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (originalRedisUrl !== undefined) {
      process.env['REDIS_URL'] = originalRedisUrl;
    } else {
      delete process.env['REDIS_URL'];
    }
    if (originalNodeEnv !== undefined) {
      process.env['NODE_ENV'] = originalNodeEnv;
    } else {
      delete process.env['NODE_ENV'];
    }
  });

  it('si REDIS_URL no está seteado, no arranca y loguea warn', async () => {
    delete process.env['REDIS_URL'];
    const { registry } = buildRegistryStub();
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never;

    const worker = new SubscriptionsGraceExpirationWorker(registry, logger);
    await worker.onApplicationBootstrap();

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('en NODE_ENV=test no arranca aunque haya REDIS_URL', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:9999';
    process.env['NODE_ENV'] = 'test';
    const { registry } = buildRegistryStub();
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never;

    const worker = new SubscriptionsGraceExpirationWorker(registry, logger);

    // No debe intentar conectar a Redis ni loguear "scheduler activo".
    await worker.onApplicationBootstrap();

    expect(logger.log).not.toHaveBeenCalled();
  });
});
