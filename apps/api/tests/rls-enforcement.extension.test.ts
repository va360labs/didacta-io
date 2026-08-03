import { describe, expect, it, vi } from 'vitest';
import {
  buildTenantScopedModelSet,
  createRlsEnforcementExtension,
  isInsidePrismaTransaction,
  markPrismaTransactionScope,
  resolveRlsEnforcementMode,
  runCallerTransaction,
  type RlsEnforcementOptions,
} from '../src/prisma/rls-enforcement.extension';
import { RlsGapTelemetry } from '../src/prisma/rls-gap-telemetry';

describe('resolveRlsEnforcementMode', () => {
  it('default on cuando no hay env (release intermedia F3: huecos a error)', () => {
    expect(resolveRlsEnforcementMode(undefined)).toBe('on');
  });

  it('normaliza mayúsculas y espacios', () => {
    expect(resolveRlsEnforcementMode(' ON ')).toBe('on');
    expect(resolveRlsEnforcementMode('Off')).toBe('off');
    expect(resolveRlsEnforcementMode(' Warn ')).toBe('warn');
  });

  it('valores desconocidos caen al default on', () => {
    expect(resolveRlsEnforcementMode('bogus')).toBe('on');
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
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
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

  it('acceso global sancionado sobre modelo multi-tenant: bypass real vía SET LOCAL ROLE didacta_super', async () => {
    const { hook, onGap, fakeClient } = setupHook({
      getContext: () => undefined,
      isSanctioned: () => true,
    });
    const result = await hook({ model: 'User', operation: 'findMany', args: {}, query });
    expect(result).toEqual(queryResult);
    expect(onGap).not.toHaveBeenCalled();
    // didacta_app no tiene BYPASSRLS: sin el switch de rol, la query sancionada
    // devolvería 0 filas en real. El wrap es necesario, no opcional.
    expect(fakeClient.$transaction).toHaveBeenCalledTimes(1);
    const setRole = fakeClient.$executeRaw.mock.results[0]!.value as { sql: string };
    expect(setRole.sql).toContain('SET LOCAL ROLE didacta_super');
  });

  it('acceso global sancionado sobre modelo global: ni hueco ni wrap (no hay RLS que saltar)', async () => {
    const { hook, onGap, fakeClient } = setupHook({
      getContext: () => undefined,
      isSanctioned: () => true,
    });
    await hook({ model: 'Tenant', operation: 'findMany', args: {}, query });
    expect(onGap).not.toHaveBeenCalled();
    expect(fakeClient.$transaction).not.toHaveBeenCalled();
  });

  it('sancionado dentro de un $transaction del caller: NO envuelve aquí (el switch de rol lo inyecta runCallerTransaction)', async () => {
    const { hook, onGap, fakeClient } = setupHook({
      getContext: () => undefined,
      isSanctioned: () => true,
      isInTransaction: () => isInsidePrismaTransaction(),
    });
    const result = await markPrismaTransactionScope(() =>
      hook({ model: 'User', operation: 'findUnique', args: {}, query }),
    );
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

describe('runCallerTransaction (inyección del GUC en $transaction del caller — F2 @tx)', () => {
  const SET_CFG = { __setConfig: true };
  const makeSetConfig = () => SET_CFG;
  // runWithGucApplied real-ish: marca que el scope se abrió.
  function makeRunner() {
    let opened = false;
    const runWithGucApplied = async <T>(fn: () => Promise<T>): Promise<T> => {
      opened = true;
      return fn();
    };
    return { runWithGucApplied, wasOpened: () => opened };
  }

  it('forma batch con contexto sin gucApplied: antepone el set_config y descarta su resultado', async () => {
    const { runWithGucApplied, wasOpened } = makeRunner();
    const original = vi.fn(async (members: unknown[]) =>
      members.map((_, i) => (i === 0 ? 'setcfg' : `row-${i}`)),
    );
    const out = await runCallerTransaction({
      original,
      args: [['op-a', 'op-b']],
      ctx: { tenantId: 't-1' },
      makeSetConfig,
      runWithGucApplied,
    });
    // El caller recibe solo SUS resultados (el miembro inyectado se recorta).
    expect(out).toEqual(['row-1', 'row-2']);
    const passed = original.mock.calls[0]![0] as unknown[];
    expect(passed[0]).toBe(SET_CFG);
    expect(passed.slice(1)).toEqual(['op-a', 'op-b']);
    expect(wasOpened()).toBe(true);
  });

  it('forma interactiva con contexto sin gucApplied: setea el GUC como primera op del callback', async () => {
    const { runWithGucApplied } = makeRunner();
    const queryRawCalls: unknown[][] = [];
    const tx = {
      $queryRaw: (...a: unknown[]) => {
        queryRawCalls.push(a);
        return Promise.resolve();
      },
    };
    const original = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const userCallback = vi.fn(async () => 'result');
    const out = await runCallerTransaction({
      original,
      args: [userCallback],
      ctx: { tenantId: 't-9' },
      makeSetConfig,
      runWithGucApplied,
    });
    expect(out).toBe('result');
    // El set_config corrió ANTES del callback del usuario.
    expect(queryRawCalls).toHaveLength(1);
    expect(userCallback).toHaveBeenCalledWith(tx);
  });

  it('con gucApplied: no inyecta nada, solo marca el scope de transacción', async () => {
    const { runWithGucApplied, wasOpened } = makeRunner();
    const original = vi.fn(async () => 'passthrough');
    const inTxDuringCall = { seen: false };
    const out = await runCallerTransaction({
      original: async (...a: unknown[]) => {
        inTxDuringCall.seen = isInsidePrismaTransaction();
        return original(...a);
      },
      args: [() => Promise.resolve()],
      ctx: { tenantId: 't-1', gucApplied: true },
      makeSetConfig,
      runWithGucApplied,
    });
    expect(out).toBe('passthrough');
    // gucApplied ⇒ no se abre el scope de tenant, pero SÍ el marker de tx.
    expect(wasOpened()).toBe(false);
    expect(inTxDuringCall.seen).toBe(true);
  });

  it('sin contexto de tenant: passthrough con solo el marker de transacción', async () => {
    const { runWithGucApplied, wasOpened } = makeRunner();
    const original = vi.fn(async () => 'no-ctx');
    const out = await runCallerTransaction({
      original,
      args: [['op']],
      ctx: undefined,
      makeSetConfig,
      runWithGucApplied,
    });
    expect(out).toBe('no-ctx');
    expect(wasOpened()).toBe(false);
    // No se inyectó el set_config: el caller recibe sus args tal cual.
    expect(original.mock.calls[0]![0]).toEqual(['op']);
  });

  it('sancionado sin tenantId, forma batch: antepone SET LOCAL ROLE y descarta su resultado', async () => {
    const SET_ROLE = { __setRole: true };
    const makeSetRole = () => SET_ROLE;
    const original = vi.fn(async (members: unknown[]) =>
      members.map((_, i) => (i === 0 ? 'setrole' : `row-${i}`)),
    );
    const out = await runCallerTransaction({
      original,
      args: [['op-a', 'op-b']],
      ctx: undefined,
      makeSetConfig,
      runWithGucApplied: async (fn) => fn(),
      isSanctioned: () => true,
      makeSetRole,
    });
    expect(out).toEqual(['row-1', 'row-2']);
    const passed = original.mock.calls[0]![0] as unknown[];
    expect(passed[0]).toBe(SET_ROLE);
    expect(passed.slice(1)).toEqual(['op-a', 'op-b']);
  });

  it('sancionado sin tenantId, forma interactiva: setea el rol como primera op del callback', async () => {
    const executeRawCalls: unknown[][] = [];
    const tx = {
      $executeRaw: (...a: unknown[]) => {
        executeRawCalls.push(a);
        return Promise.resolve();
      },
    };
    const original = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const userCallback = vi.fn(async () => 'result');
    const out = await runCallerTransaction({
      original,
      args: [userCallback],
      ctx: undefined,
      makeSetConfig,
      runWithGucApplied: async (fn) => fn(),
      isSanctioned: () => true,
      makeSetRole: () => ({}),
    });
    expect(out).toBe('result');
    expect(executeRawCalls).toHaveLength(1);
    expect(userCallback).toHaveBeenCalledWith(tx);
  });

  it('sancionado pero ya gucApplied: no inyecta el rol (ya hay GUC de tenant en la tx)', async () => {
    const makeSetRole = vi.fn(() => ({}));
    const original = vi.fn(async () => 'passthrough');
    const out = await runCallerTransaction({
      original,
      args: [['op']],
      ctx: { tenantId: 't-1', gucApplied: true },
      makeSetConfig,
      runWithGucApplied: async (fn) => fn(),
      isSanctioned: () => true,
      makeSetRole,
    });
    expect(out).toBe('passthrough');
    expect(makeSetRole).not.toHaveBeenCalled();
    expect(original.mock.calls[0]![0]).toEqual(['op']);
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
