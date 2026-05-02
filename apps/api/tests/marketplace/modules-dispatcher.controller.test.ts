import { HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ModuleRouterService } from '../../src/marketplace/module-router.service';
import { ModulesDispatcherController } from '../../src/marketplace/modules-dispatcher.controller';
import type { SessionClaims } from '../../src/auth/token.service';
import type { FastifyReply, FastifyRequest } from 'fastify';

function makeReq(overrides: Partial<FastifyRequest>): FastifyRequest {
  return {
    method: 'GET',
    url: '/api/v1/modules/example/hello',
    query: {},
    ...overrides,
  } as FastifyRequest;
}

function makeReply(): {
  reply: FastifyReply;
  state: { status: number | undefined; body: unknown; headers: Record<string, string> };
} {
  const state = { status: undefined as number | undefined, body: undefined as unknown, headers: {} as Record<string, string> };
  const reply = {
    status: vi.fn(function (this: any, s: number) {
      state.status = s;
      return this;
    }),
    send: vi.fn(function (this: any, b: unknown) {
      state.body = b;
      return this;
    }),
    header: vi.fn(function (this: any, k: string, v: string) {
      state.headers[k] = v;
      return this;
    }),
  } as unknown as FastifyReply;
  return { reply, state };
}

function user(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return { sub: 'u-1', tenantId: 't-1', roles: ['alumno'], mfaVerified: true, ...overrides } as SessionClaims;
}

describe('ModulesDispatcherController.dispatch', () => {
  it('despacha al handler registrado y devuelve su body', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async (ctx: any) => ({
      status: 200,
      body: { from: ctx.params.id },
    }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/items/:id', handler },
    ]);
    const ctrl = new ModulesDispatcherController(router);
    const req = makeReq({ url: '/api/v1/modules/example/items/42', method: 'GET' });
    const { reply, state } = makeReply();

    await ctrl.dispatch(req, reply, user(), undefined);

    expect(handler).toHaveBeenCalledOnce();
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ from: '42' });
  });

  it('404 si no hay handler', async () => {
    const router = new ModuleRouterService();
    const ctrl = new ModulesDispatcherController(router);
    const req = makeReq({ url: '/api/v1/modules/ghost/foo' });
    const { reply } = makeReply();
    await expect(ctrl.dispatch(req, reply, user(), undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('passes query, body y user al handler', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'POST', path: '/echo', handler },
    ]);
    const ctrl = new ModulesDispatcherController(router);
    const req = makeReq({
      url: '/api/v1/modules/example/echo?a=1',
      method: 'POST',
      query: { a: '1' },
    });
    const { reply } = makeReply();

    await ctrl.dispatch(req, reply, user({ roles: ['formador'] }), { hello: 'world' });

    const ctx = handler.mock.calls[0][0];
    expect(ctx.query).toEqual({ a: '1' });
    expect(ctx.body).toEqual({ hello: 'world' });
    expect(ctx.user).toEqual({ sub: 'u-1', tenantId: 't-1', roles: ['formador'] });
  });

  it('user=null si no hay sesión', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/public', handler },
    ]);
    const ctrl = new ModulesDispatcherController(router);
    const req = makeReq({ url: '/api/v1/modules/example/public' });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined, undefined);
    expect(handler.mock.calls[0][0].user).toBeNull();
  });

  it('500 si el handler lanza', async () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', '/modules/example', [
      {
        method: 'GET',
        path: '/boom',
        handler: async () => {
          throw new Error('boom interno');
        },
      },
    ]);
    const ctrl = new ModulesDispatcherController(router);
    const req = makeReq({ url: '/api/v1/modules/example/boom' });
    const { reply } = makeReply();
    await expect(ctrl.dispatch(req, reply, user(), undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('handler con headers personalizados los aplica al reply', async () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', '/modules/example', [
      {
        method: 'GET',
        path: '/with-headers',
        handler: async () => ({
          status: 201,
          body: { ok: true },
          headers: { 'x-mod': 'example' },
        }),
      },
    ]);
    const ctrl = new ModulesDispatcherController(router);
    const req = makeReq({ url: '/api/v1/modules/example/with-headers' });
    const { reply, state } = makeReply();
    await ctrl.dispatch(req, reply, user(), undefined);
    expect(state.headers['x-mod']).toBe('example');
    expect(state.status).toBe(201);
  });

  it('handler sin body devuelve 204', async () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', '/modules/example', [
      { method: 'DELETE', path: '/x', handler: async () => undefined as never },
    ]);
    const ctrl = new ModulesDispatcherController(router);
    const req = makeReq({ url: '/api/v1/modules/example/x', method: 'DELETE' });
    const { reply, state } = makeReply();
    await ctrl.dispatch(req, reply, user(), undefined);
    expect(state.status).toBe(204);
  });
});
