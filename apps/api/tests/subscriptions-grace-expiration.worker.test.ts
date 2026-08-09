import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionsGraceExpirationWorker } from '../src/modules/subscriptions/subscriptions-grace-expiration.worker';
import { tenantContextStorage } from '../src/tenancy/tenant-context.storage';

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function buildRegistryStub(
  opts: { initialized?: boolean; expiredByTenant?: Record<string, unknown[]> } = {},
) {
  const expiredByTenant = opts.expiredByTenant ?? {};
  // Los parámetros se declaran aunque el doble no los use: el worker llama
  // `findTenantsWithExpiredGrace(now)` y `expireGracePeriodsForTenant(tenantId, now)`.
  // Sin declararlos, `mock.calls[0][0]` no existe para el typecheck y la
  // aserción sobre el `now` propagado sería incomprobable.
  const findTenantsWithExpiredGrace = vi.fn(async (_now: Date) => Object.keys(expiredByTenant));
  const expireGracePeriodsForTenant = vi.fn(
    async (tenantId: string, _now: Date) => expiredByTenant[tenantId] ?? [],
  );
  const service = { findTenantsWithExpiredGrace, expireGracePeriodsForTenant };
  const registry = {
    getSubscriptionsService: vi.fn(() => {
      if (opts.initialized === false) {
        throw new Error('mod.subscriptions no está inicializado.');
      }
      return service;
    }),
  };
  return { registry, service, findTenantsWithExpiredGrace, expireGracePeriodsForTenant };
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

  it('barre tenants y expira por tenant cuando se llama triggerNow()', async () => {
    const { registry, findTenantsWithExpiredGrace, expireGracePeriodsForTenant } =
      buildRegistryStub({
        expiredByTenant: {
          t1: [{ id: 's1', tenantId: 't1', userId: 'u1', courseId: 'c1', status: 'UNPAID' }],
          t2: [
            { id: 's2', tenantId: 't2', userId: 'u2', courseId: 'c2', status: 'UNPAID' },
            { id: 's3', tenantId: 't2', userId: 'u3', courseId: 'c3', status: 'UNPAID' },
          ],
        },
      });

    const worker = new SubscriptionsGraceExpirationWorker(registry as never, noopLogger);

    // Sin onApplicationBootstrap (no Redis). triggerNow debe degradar a in-process.
    await worker.triggerNow();

    expect(registry.getSubscriptionsService).toHaveBeenCalledTimes(1);
    expect(findTenantsWithExpiredGrace).toHaveBeenCalledTimes(1);
    expect(expireGracePeriodsForTenant).toHaveBeenCalledTimes(2);
    // El mismo `now` del sweep viaja al procesado por tenant (consistencia).
    const now = findTenantsWithExpiredGrace.mock.calls[0]![0];
    expect(expireGracePeriodsForTenant).toHaveBeenCalledWith('t1', now);
    expect(expireGracePeriodsForTenant).toHaveBeenCalledWith('t2', now);
  });

  it('el procesado por tenant corre bajo el contexto ALS de ESE tenant (patrón F3)', async () => {
    const seenContexts: Array<string | undefined> = [];
    const findTenantsWithExpiredGrace = vi.fn(async () => ['t1', 't2']);
    const expireGracePeriodsForTenant = vi.fn(async () => {
      seenContexts.push(tenantContextStorage.getStore()?.tenantId);
      return [];
    });
    const registry = {
      getSubscriptionsService: vi.fn(() => ({
        findTenantsWithExpiredGrace,
        expireGracePeriodsForTenant,
      })),
    } as never;

    const worker = new SubscriptionsGraceExpirationWorker(registry as never, noopLogger);
    await worker.triggerNow();

    expect(seenContexts).toEqual(['t1', 't2']);
  });

  it('si mod.subscriptions no está inicializado, loguea warn y NO lanza', async () => {
    const { registry } = buildRegistryStub({ initialized: false });
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const worker = new SubscriptionsGraceExpirationWorker(registry as never, logger as never);

    await expect(worker.triggerNow()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    // El warn debe mencionar que el módulo no está inicializado
    const warnArgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(warnArgs)).toContain('no inicializado');
  });

  it('si el barrido lanza, el worker re-lanza (para retry de BullMQ)', async () => {
    const findTenantsWithExpiredGrace = vi.fn(async () => {
      throw new Error('boom');
    });
    const registry = {
      getSubscriptionsService: vi.fn(() => ({
        findTenantsWithExpiredGrace,
        expireGracePeriodsForTenant: vi.fn(),
      })),
    } as never;

    const worker = new SubscriptionsGraceExpirationWorker(registry as never, noopLogger);

    await expect(worker.triggerNow()).rejects.toThrow('boom');
    expect(findTenantsWithExpiredGrace).toHaveBeenCalledTimes(1);
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
    };

    const worker = new SubscriptionsGraceExpirationWorker(registry as never, logger as never);
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
    };

    const worker = new SubscriptionsGraceExpirationWorker(registry as never, logger as never);

    // No debe intentar conectar a Redis ni loguear "scheduler activo".
    await worker.onApplicationBootstrap();

    expect(logger.log).not.toHaveBeenCalled();
  });
});
