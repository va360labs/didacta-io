import { describe, expect, it, vi } from 'vitest';
import {
  compilePathPattern,
  ModuleRouterService,
  type ModuleRoute,
} from '../../src/marketplace/module-router.service';

const NS = '/modules/example';

function makeRoute(method: ModuleRoute['method'], path: string): ModuleRoute {
  return { method, path, handler: vi.fn(async () => ({ status: 200, body: { ok: true } })) };
}

describe('compilePathPattern', () => {
  it('path simple', () => {
    const { pattern, paramNames } = compilePathPattern('/modules/example/hello');
    expect(paramNames).toEqual([]);
    expect('/modules/example/hello'.match(pattern)).toBeTruthy();
    expect('/modules/example/world'.match(pattern)).toBeNull();
  });

  it('path con un param', () => {
    const { pattern, paramNames } = compilePathPattern('/modules/example/items/:id');
    expect(paramNames).toEqual(['id']);
    const m = '/modules/example/items/42'.match(pattern);
    expect(m?.[1]).toBe('42');
  });

  it('path con varios params', () => {
    const { pattern, paramNames } = compilePathPattern('/modules/example/items/:id/comments/:cid');
    expect(paramNames).toEqual(['id', 'cid']);
    const m = '/modules/example/items/abc/comments/xyz'.match(pattern);
    expect(m?.[1]).toBe('abc');
    expect(m?.[2]).toBe('xyz');
  });
});

describe('ModuleRouterService', () => {
  it('registerModule + match resuelve handler con params', () => {
    const router = new ModuleRouterService();
    const route = makeRoute('GET', '/items/:id');
    router.registerModule('mod.example', NS, [route]);
    const matched = router.match('GET', '/modules/example/items/42');
    expect(matched).not.toBeNull();
    expect(matched?.moduleName).toBe('mod.example');
    expect(matched?.params).toEqual({ id: '42' });
  });

  it('match=null si method/path no registrados', () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', NS, [makeRoute('GET', '/items')]);
    expect(router.match('POST', '/modules/example/items')).toBeNull();
    expect(router.match('GET', '/modules/example/other')).toBeNull();
  });

  it('unregisterModule borra todas las routes del módulo', () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', NS, [makeRoute('GET', '/a'), makeRoute('GET', '/b')]);
    router.unregisterModule('mod.example');
    expect(router.match('GET', '/modules/example/a')).toBeNull();
    expect(router.match('GET', '/modules/example/b')).toBeNull();
  });

  it('upgrade in-place: re-register reemplaza las routes anteriores', () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', NS, [makeRoute('GET', '/old')]);
    router.registerModule('mod.example', NS, [makeRoute('GET', '/new')]);
    expect(router.match('GET', '/modules/example/old')).toBeNull();
    expect(router.match('GET', '/modules/example/new')).not.toBeNull();
  });

  it('listRoutes filtra por módulo', () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.a', '/modules/a', [makeRoute('GET', '/x')]);
    router.registerModule('mod.b', '/modules/b', [makeRoute('POST', '/y')]);
    expect(router.listRoutes('mod.a')).toEqual([
      { moduleName: 'mod.a', method: 'GET', path: '/modules/a/x' },
    ]);
    expect(router.listRoutes()).toHaveLength(2);
  });

  it.each([
    ['method inválido', { method: 'OPTIONS' as never, path: '/x', handler: () => ({}) }],
    ['path sin /', { method: 'GET' as const, path: 'x', handler: () => ({}) }],
    ['path con //', { method: 'GET' as const, path: '/a//b', handler: () => ({}) }],
    ['path con ..', { method: 'GET' as const, path: '/a/../b', handler: () => ({}) }],
    ['handler no función', { method: 'GET' as const, path: '/x', handler: 'string' as never }],
  ])('rechaza route mal formada (%s)', (_, badRoute) => {
    const router = new ModuleRouterService();
    expect(() => router.registerModule('mod.example', NS, [badRoute])).toThrow();
  });

  it('routes=[] no registra nada y deja el módulo sin entradas', () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', NS, []);
    expect(router.listRoutes('mod.example')).toEqual([]);
  });

  it('decodifica URI components en params', () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', NS, [makeRoute('GET', '/items/:id')]);
    const matched = router.match('GET', '/modules/example/items/hello%20world');
    expect(matched?.params.id).toBe('hello world');
  });
});
