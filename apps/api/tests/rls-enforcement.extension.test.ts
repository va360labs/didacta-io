import { describe, expect, it, vi } from 'vitest';
import {
  buildTenantScopedModelSet,
  createRlsEnforcementExtension,
  isInsidePrismaTransaction,
  markPrismaTransactionScope,
  resolveRlsEnforcementMode,
  type RlsEnforcementOptions,
} from '../src/prisma/rls-enforcement.extension';
import { RlsGapTelemetry } from '../src/prisma/rls-gap-telemetry';

describe('resolveRlsEnforcementMode', () => {
  it('default warn cuando no hay env', () => {
    expect(resolveRlsEnforcementMode(undefined)).toBe('warn');
  });

  it('normaliza mayúsculas y espacios', () => {
    expect(resolveRlsEnforcementMode(' ON ')).toBe('on');
    expect(resolveRlsEnforcementMode('Off')).toBe('off');
  });

  it('valores desconocidos caen a warn', () => {
    expect(resolveRlsEnforcementMode('bogus')).toBe('warn');
  });
});

describe('buildTenantScopedModelSet', () => {
  it('incluye los modelos con tenantId y excluye los globales', () => {
    const set = buildTenantScopedModelSet();
    // El DMMF del cliente generado está disponible en tests.
    expect(set.size).toBeGreaterThan(50);
    expect(set.has('User')).toBe(true);
    expect(set.has('TenantDomain')).toBe(true);
    // Tenant e InstalledModule son tablas globales de instancia.
    expect(set.has('Tenant')).toBe(false);
    expect(set.has('InstalledModule')).toBe(false);
  });
});

/**
 * Ejecuta el hook $allOperations de la extensión contra un cliente falso que
 * captura la config y simula el batch $transaction (devuelve el segundo
 * miembro, como Prisma).
 */
function setupHook(opts: Partial<RlsEnforcementOptions> = {}) {
  const onGap = vi.fn();
  const fakeClient = {
    captured: undefined as
      | { query: { $allModels: { $allOperations: (p: unknown) => Promise<unknown> } } }
      | undefined,
    $extends(cfg: never) {
      this.captured = cfg;
      return this;
    },
    $transaction: vi.fn(async (members: Array<Promise<unknown>>) => [
      'setcfg-result',
      await members[1],
    ]),
    $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join('$'),
      values,
    })),
  };
  const ext = createRlsEnforcementExtension({
    mode: 'warn',
    getContext: () => undefined,
    tenantModels: new Set(['User']),
    onGap,
    ...opts,
  });
  ext(fakeClient as never);
  const hook = fakeClient.captured!.query.$allModels.$allOperations;
  return { hook, onGap, fakeClient };
}

describe('createRlsEnforcementExtension', () => {
  const queryResult = [{ id: 'row-1' }];
  const query = vi.fn(async () => queryResult);

  it('sin contexto sobre modelo multi-tenant: registra hueco y deja pasar', async () => {
    const { hook, onGap, fakeClient } = setupHook({ getContext: () => undefined });
    const result = await hook({ model: 'User', operation: 'findMany', args: {}, query });
    expect(result).toEqual(queryResult);
    expect(onGap).toHaveBeenCalledWith({ model: 'User', operation: 'findMany' });
    expect(fakeClient.$transaction).not.toHaveBeenCalled();
  });

  it('sin contexto sobre modelo global: ni hueco ni wrap', async () => {
    const { hook, onGap, fakeClient } = setupHook({ getContext: () => undefined });
    await hook({ model: 'Tenant', operation: 'findMany', args: {}, query });
    expect(onGap).not.toHaveBeenCalled();
    expect(fakeClient.$transaction).not.toHaveBeenCalled();
  });

  it('con gucApplied: no envuelve (el GUC ya viaja en la transacción externa)', async () => {
    const { hook, fakeClient } = setupHook({
      getContext: () => ({ tenantId: 't-1', gucApplied: true }),
    });
    const result = await hook({ model: 'User', operation: 'findMany', args: {}, query });
    expect(result).toEqual(queryResult);
    expect(fakeClient.$transaction).not.toHaveBeenCalled();
  });

  it('con contexto: envuelve en batch con set_config parametrizado', async () => {
    const { hook, fakeClient } = setupHook({ getContext: () => ({ tenantId: 't-42' }) });
    const result = await hook({ model: 'User', operation: 'findMany', args: {}, query });
    expect(result).toEqual(queryResult);
    expect(fakeClient.$transaction).toHaveBeenCalledTimes(1);
    const setCfg = fakeClient.$queryRaw.mock.results[0]!.value as {
      sql: string;
      values: unknown[];
    };
    expect(setCfg.sql).toContain("set_config('app.current_tenant_id'");
    expect(setCfg.values).toEqual(['t-42']);
  });

  it('modelo global con contexto: pasa sin wrap', async () => {
    const { hook, fakeClient } = setupHook({ getContext: () => ({ tenantId: 't-1' }) });
    await hook({ model: 'Tenant', operation: 'findMany', args: {}, query });
    expect(fakeClient.$transaction).not.toHaveBeenCalled();
  });

  it('set de modelos vacío: trata todo como multi-tenant (fallback conservador)', async () => {
    const { hook, onGap } = setupHook({
      getContext: () => undefined,
      tenantModels: new Set<string>(),
    });
    await hook({ model: 'Tenant', operation: 'findMany', args: {}, query });
    expect(onGap).toHaveBeenCalled();
  });

  it('acceso global sancionado sin contexto: pasa sin registrar hueco', async () => {
    const { hook, onGap, fakeClient } = setupHook({
      getContext: () => undefined,
      isSanctioned: () => true,
    });
    const result = await hook({ model: 'User', operation: 'findMany', args: {}, query });
    expect(result).toEqual(queryResult);
    expect(onGap).not.toHaveBeenCalled();
    expect(fakeClient.$transaction).not.toHaveBeenCalled();
  });

  it('dentro de un $transaction del caller: NO envuelve (lo sacaría de su tx) y telemetría @tx', async () => {
    const { hook, onGap, fakeClient } = setupHook({
      getContext: () => ({ tenantId: 't-1' }),
      isInTransaction: () => isInsidePrismaTransaction(),
    });
    const result = await markPrismaTransactionScope(() =>
      hook({ model: 'User', operation: 'create', args: {}, query }),
    );
    expect(result).toEqual(queryResult);
    // Sin wrap: la operación se queda en la transacción del caller.
    expect(fakeClient.$transaction).not.toHaveBeenCalled();
    expect(onGap).toHaveBeenCalledWith({ model: 'User', operation: 'create@tx' });
    // Fuera del scope, la misma operación SÍ se envuelve.
    await hook({ model: 'User', operation: 'create', args: {}, query });
    expect(fakeClient.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('RlsGapTelemetry', () => {
  it('cuenta por firma y loguea solo la primera vez', () => {
    const t = new RlsGapTelemetry('warn');
    t.record({ model: 'User', operation: 'findMany' });
    t.record({ model: 'User', operation: 'findMany' });
    t.record({ model: 'User', operation: 'count' });
    expect(t.snapshot()).toEqual({ 'User.findMany': 2, 'User.count': 1 });
  });
});
