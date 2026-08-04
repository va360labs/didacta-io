import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { ModuleJobLifecycleRegistry } from '../../src/marketplace/job-runner/mod-jobs-lifecycle.registry';
import {
  ModJobsWorkerService,
  TickTimeoutError,
  runWithTimeout,
} from '../../src/marketplace/job-runner/mod-jobs.worker';
import type {
  ModJobPayload,
  ModJobsQueueService,
} from '../../src/marketplace/job-runner/mod-jobs.queue';
import type {
  JobTickResult,
  ModuleJobTickContext,
  ModuleJobTickHandler,
} from '../../src/marketplace/job-runner/mod-jobs.types';
import type { ModJobsMetrics } from '../../src/marketplace/job-runner/mod-jobs.metrics';
import { TenantContextService } from '../../src/tenancy/tenant-context.service';

/// Tests del ModJobsWorkerService (Sprint 3 / JR-002).
///
/// Mockeamos toda la cadena de wiring (queue, sandboxed services, didacta
/// factory, module registry, context factory) para que el worker corra
/// aislado de Redis / Postgres. Foco: que el flujo de control sea
/// correcto (continue → re-encolar, completed → no, failed → no, timeout
/// → re-encolar, error → re-encolar, unregistered → skip) y que el
/// tenant context se propague correctamente al handler.

// ─────────────────────────────────────────────────────────────────────────────
// Helpers para construir un worker con dependencias mockeadas
// ─────────────────────────────────────────────────────────────────────────────

function makeWorkerHarness(
  handler: ModuleJobTickHandler | null,
  opts: { dbEnabled?: boolean; httpConfig?: unknown; didactaConfig?: unknown } = {},
) {
  const registry = new ModuleJobLifecycleRegistry();
  if (handler) {
    registry.register('mod.test', handler, {
      httpConfig: (opts.httpConfig as never) ?? null,
      dbEnabled: opts.dbEnabled ?? false,
      tablePrefix: 'mod_test_',
      didactaConfig: (opts.didactaConfig as never) ?? null,
      requiresSecrets: false,
      secretsLifecycleConfig: null,
      moduleVersion: '1.0.0',
    });
  }

  const enqueue = vi.fn(async () => undefined);
  const queueService = {
    isEnabled: () => true,
    enqueue,
  } as unknown as ModJobsQueueService;

  const metrics = {
    recordTick: vi.fn(),
    recordTickDuration: vi.fn(),
  } as unknown as ModJobsMetrics;

  const dbBuild = vi.fn(() => ({ kind: 'real-db' }) as unknown);
  const dbService = {
    build: dbBuild,
  } as unknown as import('../../src/marketplace/sandboxed-db.service').SandboxedDbService;

  const httpService = {
    build: vi.fn(() => ({ kind: 'real-http' }) as unknown),
  } as unknown as import('../../src/marketplace/sandboxed-http.service').SandboxedHttpService;

  const rateLimiter =
    {} as unknown as import('../../src/marketplace/rate-limiter.service').RateLimiterService;

  const didactaFactory = {
    build: vi.fn(() => ({ kind: 'real-didacta' }) as unknown),
  } as unknown as import('../../src/marketplace/sandboxed-didacta.service').ScopedDidactaApiFactory;

  const moduleRegistry = {
    getCoursesService: () => ({}) as never,
    getLearningService: () => ({}) as never,
    getAssessmentsService: () => ({}) as never,
  } as unknown as import('../../src/modules/module-registry.service').ModuleRegistryService;

  const contextFactory = {
    getStorage: () => ({}) as never,
  } as unknown as import('../../src/modules/module-context.factory').ModuleContextFactory;

  const tenantContext = new TenantContextService();

  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('nestjs-pino').Logger;

  const tenantResolver = {
    resolveTenantWebBaseUrl: vi.fn(async () => 'http://test.local'),
  } as unknown as import('../../src/tenancy/tenant-resolver.service').TenantResolverService;

  const worker = new ModJobsWorkerService(
    queueService,
    registry,
    dbService,
    httpService,
    rateLimiter,
    didactaFactory,
    // alpha.56 — ScopedSecretsApiFactory stub; los tests del worker no
    // ejercen ctx.secrets (registran entries con requiresSecrets=false).
    {
      resolve: () => ({
        get: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [],
      }),
    } as never,
    moduleRegistry,
    contextFactory,
    tenantContext,
    metrics,
    logger,
    tenantResolver,
  );

  return {
    worker,
    registry,
    enqueue,
    metrics,
    tenantContext,
    dbBuild,
    didactaBuild: didactaFactory.build,
  };
}

function makeJob(payload: Partial<ModJobPayload> = {}): Job<ModJobPayload> {
  return {
    data: {
      moduleName: 'mod.test',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      tickIndex: 0,
      ...payload,
    },
  } as unknown as Job<ModJobPayload>;
}

// ─────────────────────────────────────────────────────────────────────────────
// runWithTimeout helper
// ─────────────────────────────────────────────────────────────────────────────

describe('runWithTimeout', () => {
  it('devuelve el resultado del handler sync sin tocar el timer', async () => {
    const handler: ModuleJobTickHandler = () => ({ status: 'completed' });
    const ctx = {} as ModuleJobTickContext;
    const r = await runWithTimeout(handler, ctx, 1000);
    expect(r.status).toBe('completed');
  });

  it('devuelve el resultado del handler async si vuelve antes del timeout', async () => {
    const handler: ModuleJobTickHandler = async () => ({ status: 'continue' });
    const ctx = {} as ModuleJobTickContext;
    const r = await runWithTimeout(handler, ctx, 1000);
    expect(r.status).toBe('continue');
  });

  it('lanza TickTimeoutError si el handler tarda más que el timeout', async () => {
    vi.useFakeTimers();
    const handler: ModuleJobTickHandler = () =>
      new Promise<JobTickResult>(() => {
        // Nunca resuelve.
      });
    const ctx = {} as ModuleJobTickContext;
    const promise = runWithTimeout(handler, ctx, 50).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60);
    const err = await promise;
    expect(err).toBeInstanceOf(TickTimeoutError);
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processTick: módulo no registrado
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsWorkerService.processTick — módulo desregistrado', () => {
  it('skip + log + métrica unregistered si el módulo no tiene handler', async () => {
    const { worker, enqueue, metrics } = makeWorkerHarness(null);
    await worker.processTick(makeJob());
    expect(enqueue).not.toHaveBeenCalled();
    expect(metrics.recordTick).toHaveBeenCalledWith('mod.test', 'unregistered');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processTick: continue → re-encolar con tickIndex+1
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsWorkerService.processTick — continue', () => {
  it('re-encola con tickIndex+1 y delaySec=0 por defecto', async () => {
    const handler = vi.fn(async () => ({ status: 'continue' as const }));
    const { worker, enqueue, metrics } = makeWorkerHarness(handler);

    await worker.processTick(makeJob({ tickIndex: 3 }));

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleName: 'mod.test',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        tickIndex: 4,
      }),
      { delaySec: 0 },
    );
    expect(metrics.recordTick).toHaveBeenCalledWith('mod.test', 'continue');
  });

  it('respeta delaySec del handler en re-encolado', async () => {
    const handler = vi.fn(async () => ({ status: 'continue' as const, delaySec: 30 }));
    const { worker, enqueue } = makeWorkerHarness(handler);
    await worker.processTick(makeJob());
    expect(enqueue).toHaveBeenCalledWith(expect.any(Object), { delaySec: 30 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processTick: completed → no re-encolar
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsWorkerService.processTick — completed', () => {
  it('NO re-encola y reporta métrica completed', async () => {
    const handler = vi.fn(async () => ({ status: 'completed' as const }));
    const { worker, enqueue, metrics } = makeWorkerHarness(handler);
    await worker.processTick(makeJob());
    expect(enqueue).not.toHaveBeenCalled();
    expect(metrics.recordTick).toHaveBeenCalledWith('mod.test', 'completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processTick: failed → no re-encolar
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsWorkerService.processTick — failed', () => {
  it('NO re-encola y reporta métrica failed', async () => {
    const handler = vi.fn(async () => ({
      status: 'failed' as const,
      reason: 'WP unreachable',
    }));
    const { worker, enqueue, metrics } = makeWorkerHarness(handler);
    await worker.processTick(makeJob());
    expect(enqueue).not.toHaveBeenCalled();
    expect(metrics.recordTick).toHaveBeenCalledWith('mod.test', 'failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processTick: excepción del handler → re-encolar con backoff
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsWorkerService.processTick — excepción no controlada', () => {
  it('re-encola con backoff y métrica error', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const { worker, enqueue, metrics } = makeWorkerHarness(handler);
    await worker.processTick(makeJob({ tickIndex: 5 }));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tickIndex: 6 }),
      // ERROR_BACKOFF_SEC = 10s.
      { delaySec: 10 },
    );
    expect(metrics.recordTick).toHaveBeenCalledWith('mod.test', 'error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processTick: timeout 5min → re-encolar
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsWorkerService.processTick — timeout 5min', () => {
  it('aborta y re-encola con backoff cuando el handler nunca resuelve', async () => {
    vi.useFakeTimers();
    const handler: ModuleJobTickHandler = () =>
      new Promise<JobTickResult>(() => {
        // pending forever
      });
    const { worker, enqueue, metrics } = makeWorkerHarness(handler);
    const promise = worker.processTick(makeJob({ tickIndex: 0 }));
    // El timeout duro es 5min → avanzamos un poco más.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    await promise;
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ tickIndex: 1 }), {
      delaySec: 10,
    });
    expect(metrics.recordTick).toHaveBeenCalledWith('mod.test', 'timeout');
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processTick: TenantContext propagado al handler
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsWorkerService.processTick — TenantContext', () => {
  it('propaga tenantId al ALS antes de invocar el handler', async () => {
    let capturedTenantId: string | undefined;
    let capturedTraceId: string | undefined;
    const tenantContext = new TenantContextService();

    const handler: ModuleJobTickHandler = async () => {
      // Dentro del handler, TenantContextService.require() debe resolver
      // al tenant del payload — lo verifica que el worker hizo run().
      const ctx = tenantContext.require();
      capturedTenantId = ctx.tenantId;
      capturedTraceId = ctx.traceId;
      return { status: 'completed' };
    };

    // Construimos harness con el TenantContextService compartido (no el
    // que crea makeWorkerHarness). Para esto reusamos la lógica manualmente.
    const registry = new ModuleJobLifecycleRegistry();
    registry.register('mod.test', handler, {
      httpConfig: null,
      dbEnabled: false,
      tablePrefix: 'mod_test_',
      didactaConfig: null,
      requiresSecrets: false,
      secretsLifecycleConfig: null,
      moduleVersion: '1.0.0',
    });
    const queueService = {
      isEnabled: () => true,
      enqueue: vi.fn(),
    } as unknown as ModJobsQueueService;
    const metrics = {
      recordTick: vi.fn(),
      recordTickDuration: vi.fn(),
    } as unknown as ModJobsMetrics;

    const worker = new ModJobsWorkerService(
      queueService,
      registry,
      { build: vi.fn() } as never,
      { build: vi.fn() } as never,
      {} as never,
      { build: vi.fn() } as never,
      {
        resolve: () => ({
          get: async () => null,
          set: async () => undefined,
          delete: async () => undefined,
          list: async () => [],
        }),
      } as never,
      {} as never,
      { getStorage: () => ({}) } as never,
      tenantContext,
      metrics,
      { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      {} as never,
    );

    await worker.processTick(makeJob({ tenantId: 'tenant-xyz', jobId: 'job-42', tickIndex: 2 }));

    expect(capturedTenantId).toBe('tenant-xyz');
    expect(capturedTraceId).toBe('mod-job-job-42-2');
  });

  it('después del processTick, el ALS afuera vuelve a estar vacío', async () => {
    const handler: ModuleJobTickHandler = async () => ({ status: 'completed' });
    const { worker, tenantContext } = makeWorkerHarness(handler);
    expect(tenantContext.get()).toBeUndefined();
    await worker.processTick(makeJob());
    expect(tenantContext.get()).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processTick: ctx wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('ModJobsWorkerService.processTick — ctx wiring', () => {
  it('inyecta BlockedSandboxedDb cuando dbEnabled=false', async () => {
    let receivedDb: unknown;
    const handler: ModuleJobTickHandler = async (ctx) => {
      receivedDb = ctx.db;
      return { status: 'completed' };
    };
    const { worker, dbBuild } = makeWorkerHarness(handler, { dbEnabled: false });
    await worker.processTick(makeJob());
    // dbService.build NO fue llamado — se inyectó BlockedSandboxedDb.
    expect(dbBuild).not.toHaveBeenCalled();
    // BlockedSandboxedDb tiene constructor con moduleName.
    expect(receivedDb).toBeDefined();
    expect((receivedDb as { constructor: { name: string } }).constructor.name).toBe(
      'BlockedSandboxedDb',
    );
  });

  it('llama a dbService.build con tenantId del payload cuando dbEnabled=true', async () => {
    const handler: ModuleJobTickHandler = async () => ({ status: 'completed' });
    const { worker, dbBuild } = makeWorkerHarness(handler, { dbEnabled: true });
    await worker.processTick(makeJob({ tenantId: 'tenant-abc' }));
    expect(dbBuild).toHaveBeenCalledWith('mod.test', 'mod_test_', 'tenant-abc');
  });

  it('inyecta BlockedDidactaApi cuando didactaConfig=null', async () => {
    let receivedDidacta: unknown;
    const handler: ModuleJobTickHandler = async (ctx) => {
      receivedDidacta = ctx.didacta;
      return { status: 'completed' };
    };
    const { worker, didactaBuild } = makeWorkerHarness(handler, {
      didactaConfig: null,
    });
    await worker.processTick(makeJob());
    expect(didactaBuild).not.toHaveBeenCalled();
    expect((receivedDidacta as { constructor: { name: string } }).constructor.name).toBe(
      'BlockedDidactaApi',
    );
  });
});
