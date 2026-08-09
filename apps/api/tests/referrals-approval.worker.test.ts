import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ReferralsApprovalWorker } from '../src/modules/referrals/referrals-approval.worker';
import { tenantContextStorage } from '../src/tenancy/tenant-context.storage';

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function buildRegistryStub(opts: { approvedByTenant?: Record<string, number> } = {}) {
  const approvedByTenant = opts.approvedByTenant ?? {};
  const findTenantsWithDueCommissions = vi.fn(async (_now: Date) => Object.keys(approvedByTenant));
  const approveDueCommissionsForTenant = vi.fn(
    async (tenantId: string, _now: Date) => approvedByTenant[tenantId] ?? 0,
  );
  const registry = {
    getReferralsService: vi.fn(() => ({
      findTenantsWithDueCommissions,
      approveDueCommissionsForTenant,
    })),
  } as never;
  return { registry, findTenantsWithDueCommissions, approveDueCommissionsForTenant };
}

describe('ReferralsApprovalWorker.triggerNow (degraded mode, sin Redis)', () => {
  const originalRedisUrl = process.env['REDIS_URL'];

  beforeEach(() => {
    delete process.env['REDIS_URL'];
  });

  afterEach(() => {
    if (originalRedisUrl !== undefined) {
      process.env['REDIS_URL'] = originalRedisUrl;
    }
  });

  it('barre tenants y aprueba por tenant cuando se llama triggerNow()', async () => {
    const { registry, findTenantsWithDueCommissions, approveDueCommissionsForTenant } =
      buildRegistryStub({ approvedByTenant: { t1: 2, t2: 1 } });

    const worker = new ReferralsApprovalWorker(registry, noopLogger);
    await worker.triggerNow();

    expect(findTenantsWithDueCommissions).toHaveBeenCalledTimes(1);
    expect(approveDueCommissionsForTenant).toHaveBeenCalledTimes(2);
    // El mismo `now` del sweep viaja al procesado por tenant (consistencia).
    const now = findTenantsWithDueCommissions.mock.calls[0]![0];
    expect(approveDueCommissionsForTenant).toHaveBeenCalledWith('t1', now);
    expect(approveDueCommissionsForTenant).toHaveBeenCalledWith('t2', now);
  });

  it('el procesado por tenant corre bajo el contexto ALS de ESE tenant (patrón F3)', async () => {
    const seenContexts: Array<string | undefined> = [];
    const findTenantsWithDueCommissions = vi.fn(async (_now: Date) => ['t1', 't2']);
    const approveDueCommissionsForTenant = vi.fn(async () => {
      seenContexts.push(tenantContextStorage.getStore()?.tenantId);
      return 0;
    });
    const registry = {
      getReferralsService: vi.fn(() => ({
        findTenantsWithDueCommissions,
        approveDueCommissionsForTenant,
      })),
    } as never;

    const worker = new ReferralsApprovalWorker(registry, noopLogger);
    await worker.triggerNow();

    expect(seenContexts).toEqual(['t1', 't2']);
  });

  it('si el barrido lanza, el worker re-lanza (para retry de BullMQ)', async () => {
    const findTenantsWithDueCommissions = vi.fn(async () => {
      throw new Error('boom');
    });
    const registry = {
      getReferralsService: vi.fn(() => ({
        findTenantsWithDueCommissions,
        approveDueCommissionsForTenant: vi.fn(),
      })),
    } as never;

    const worker = new ReferralsApprovalWorker(registry, noopLogger);

    await expect(worker.triggerNow()).rejects.toThrow('boom');
    expect(findTenantsWithDueCommissions).toHaveBeenCalledTimes(1);
  });
});
