import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { ModuleAccessInterceptor } from '../src/modules/module-access.interceptor';

function makeContext(url: string, user?: { tenantId: string }): ExecutionContext {
  const request = { url, user } as any;
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as ExecutionContext;
}

function setup(
  opts: {
    modules?: Array<{ name: string; segment: string }>;
    rows?: Array<{ name: string; enabledByDefault: boolean; tenantEnabled?: boolean }>;
  } = {},
) {
  const modules = opts.modules ?? [
    { name: 'mod.courses', segment: 'courses' },
    { name: 'mod.community', segment: 'community' },
  ];
  const rows = opts.rows ?? [];

  const registry = {
    getRegistry: () => ({
      listModules: () =>
        modules.map((m) => ({
          manifest: { name: m.name, apiNamespace: `/modules/${m.segment}` },
        })),
    }),
  } as never;

  const findUnique = vi.fn(async ({ where }: any) => {
    const r = rows.find((row) => row.name === where.name);
    if (!r) return null;
    return {
      name: r.name,
      enabledByDefault: r.enabledByDefault,
      tenantModules:
        r.tenantEnabled !== undefined ? [{ tenantId: 't1', enabled: r.tenantEnabled }] : [],
    };
  });

  const prisma = { module: { findUnique } } as never;
  const interceptor = new ModuleAccessInterceptor(registry, prisma);
  const next = { handle: () => of('ok') };

  return { interceptor, next, findUnique };
}

describe('ModuleAccessInterceptor', () => {
  it('deja pasar paths que no son /modules/', async () => {
    const { interceptor, next } = setup();
    const ctx = makeContext('/api/v1/admin/modules', { tenantId: 't1' });
    const result = await interceptor.intercept(ctx, next);
    expect(result).toBeDefined();
  });

  it('deja pasar /modules/<segment> si el segment no es un módulo conocido', async () => {
    const { interceptor, next } = setup();
    const ctx = makeContext('/api/v1/modules/unknown/foo', { tenantId: 't1' });
    const result = await interceptor.intercept(ctx, next);
    expect(result).toBeDefined();
  });

  it('deja pasar si no hay user en request (ruta pre-auth)', async () => {
    const { interceptor, next } = setup();
    const ctx = makeContext('/api/v1/modules/courses/list');
    const result = await interceptor.intercept(ctx, next);
    expect(result).toBeDefined();
  });

  it('permite el acceso si el módulo está enabledByDefault y no hay fila tenant_module', async () => {
    const { interceptor, next } = setup({
      rows: [{ name: 'mod.courses', enabledByDefault: true }],
    });
    const ctx = makeContext('/api/v1/modules/courses/list', { tenantId: 't1' });
    const result = await interceptor.intercept(ctx, next);
    expect(result).toBeDefined();
  });

  it('lanza Forbidden cuando la fila tenant_module está disabled', async () => {
    const { interceptor, next } = setup({
      rows: [{ name: 'mod.courses', enabledByDefault: true, tenantEnabled: false }],
    });
    const ctx = makeContext('/api/v1/modules/courses/list', { tenantId: 't1' });
    await expect(interceptor.intercept(ctx, next)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cachea el resultado por 30s (segunda llamada no consulta DB)', async () => {
    const { interceptor, next, findUnique } = setup({
      rows: [{ name: 'mod.courses', enabledByDefault: true, tenantEnabled: true }],
    });
    const ctx1 = makeContext('/api/v1/modules/courses/a', { tenantId: 't1' });
    await interceptor.intercept(ctx1, next);
    expect(findUnique).toHaveBeenCalledTimes(1);

    const ctx2 = makeContext('/api/v1/modules/courses/b', { tenantId: 't1' });
    await interceptor.intercept(ctx2, next);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidate(tenantId, moduleName) limpia la entry específica', async () => {
    const { interceptor, next, findUnique } = setup({
      rows: [{ name: 'mod.courses', enabledByDefault: true, tenantEnabled: true }],
    });
    const ctx = makeContext('/api/v1/modules/courses/x', { tenantId: 't1' });
    await interceptor.intercept(ctx, next);
    expect(findUnique).toHaveBeenCalledTimes(1);

    interceptor.invalidate('t1', 'mod.courses');
    await interceptor.intercept(ctx, next);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('mapea correctamente el segment al moduleName via apiNamespace', async () => {
    const { interceptor, next, findUnique } = setup({
      rows: [{ name: 'mod.community', enabledByDefault: true, tenantEnabled: false }],
    });
    const ctx = makeContext('/api/v1/modules/community/posts', { tenantId: 't1' });
    await expect(interceptor.intercept(ctx, next)).rejects.toBeInstanceOf(ForbiddenException);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'mod.community' } }),
    );
  });
});
