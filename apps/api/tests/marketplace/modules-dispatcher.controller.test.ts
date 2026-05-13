import { HttpException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleRouterService } from '../../src/marketplace/module-router.service';
import { ModulesDispatcherController } from '../../src/marketplace/modules-dispatcher.controller';
import { RateLimiterService } from '../../src/marketplace/rate-limiter.service';
import { SandboxedDbService } from '../../src/marketplace/sandboxed-db.service';
import { SandboxedHttpService } from '../../src/marketplace/sandboxed-http.service';
import type { SessionClaims, TokenService } from '../../src/auth/token.service';
import { TenantContextService } from '../../src/tenancy/tenant-context.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { FastifyReply, FastifyRequest } from 'fastify';

/// Tests del dispatcher dinámico del marketplace.
///
/// Regresión cubierta (alpha.48): el dispatcher decodifica el Bearer
/// MANUALMENTE — antes de alpha.48 el comentario asumía un "JwtAuthGuard
/// opcional automático" que NO existe en NestJS, y `user` siempre llegaba
/// undefined. Resultado: cualquier handler de módulo third-party que
/// llamara `requireUser` rebotaba 401 aunque el cliente mandase Bearer
/// válido. Estos tests fijan el contrato corregido: con Bearer válido →
/// user poblado; sin Bearer / con Bearer inválido → user null y el
/// handler decide qué hacer.

function makeReq(overrides: Partial<FastifyRequest> & { headers?: Record<string, string> }): FastifyRequest {
  const { headers, ...rest } = overrides;
  return {
    method: 'GET',
    url: '/api/v1/modules/example/hello',
    query: {},
    headers: headers ?? {},
    ...rest,
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

function claims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return { sub: 'u-1', tenantId: 't-1', roles: ['alumno'], mfaVerified: true, ...overrides } as SessionClaims;
}

/// Doble del TokenService. Acepta un mapa `token → claims` para los
/// tokens válidos; cualquier otro token rechaza como verifyAccess real.
function makeTokens(validTokens: Record<string, SessionClaims> = {}): TokenService {
  return {
    verifyAccess: vi.fn(async (token: string) => {
      if (token in validTokens) return validTokens[token];
      throw new Error('token inválido');
    }),
  } as unknown as TokenService;
}

const VALID_TOKEN = 'valid.bearer.jwt';

// Services compartidos. Singletons para los tests — el dispatcher los
// recibe siempre por inyección. Reset entre describes vía afterEach abajo.
const httpSvc = new SandboxedHttpService();
const rateLimiter = new RateLimiterService();
// Stub de Prisma que devuelve siempre [] para queries — basta para los
// tests del dispatcher que solo verifican wiring de ctx.db, no la
// ejecución real de SQL (cubierta en sandboxed-db.service.test.ts).
const fakePrisma = {
  $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      $queryRawUnsafe: vi.fn(async () => []),
      $executeRawUnsafe: vi.fn(async () => 0),
    }),
  ),
} as unknown as PrismaService;
const dbSvc = new SandboxedDbService(fakePrisma);
const tenantContext = new TenantContextService();
// Stubs de los providers de DD-002/003. Los tests del dispatcher NO ejercen
// ctx.didacta (didactaConfig=null en todos los routes registrados), así que
// el dispatcher devuelve BlockedDidactaApi sin tocar el factory ni el
// resolver. Stubs vacíos suficientes — si alguno se invoca, el cast `as any`
// falla y el test se rompe explícitamente.
const didactaFactory = {} as any;
const jobsFactory = {} as any;
// Stub para SE-003 — los tests existentes registran routes sin requiresSecrets,
// así que el dispatcher devuelve BlockedSandboxedSecrets sin tocar este factory.
const secretsFactory = {
  resolve: (_module: string, _tenantId: string | null, _requires: boolean) => ({
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  }),
} as any;
const moduleRegistry = {} as any;
const contextFactory = {} as any;

afterEach(() => {
  rateLimiter.reset();
});

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
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/items/42',
      method: 'GET',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply, state } = makeReply();

    await ctrl.dispatch(req, reply, undefined);

    expect(handler).toHaveBeenCalledOnce();
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ from: '42' });
  });

  it('404 si no hay handler', async () => {
    const router = new ModuleRouterService();
    const ctrl = new ModulesDispatcherController(router, makeTokens(), httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({ url: '/api/v1/modules/ghost/foo' });
    const { reply } = makeReply();
    await expect(ctrl.dispatch(req, reply, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('passes query, body y user al handler cuando el Bearer es válido', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'POST', path: '/echo', handler },
    ]);
    const tokens = makeTokens({ [VALID_TOKEN]: claims({ roles: ['formador'] }) });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/echo?a=1',
      method: 'POST',
      query: { a: '1' },
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();

    await ctrl.dispatch(req, reply, { hello: 'world' });

    const ctx = handler.mock.calls[0][0];
    expect(ctx.query).toEqual({ a: '1' });
    expect(ctx.body).toEqual({ hello: 'world' });
    expect(ctx.user).toEqual({ sub: 'u-1', tenantId: 't-1', roles: ['formador'] });
  });

  it('user=null si no hay header Authorization', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/public', handler },
    ]);
    const ctrl = new ModulesDispatcherController(router, makeTokens(), httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({ url: '/api/v1/modules/example/public' });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);
    expect(handler.mock.calls[0][0].user).toBeNull();
  });

  it('user=null si el Bearer es inválido (no rompe la request)', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/public', handler },
    ]);
    const ctrl = new ModulesDispatcherController(router, makeTokens(), httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/public',
      headers: { authorization: 'Bearer this-is-garbage' },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);
    expect(handler.mock.calls[0][0].user).toBeNull();
  });

  it('user=null si el header no empieza con "Bearer "', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/public', handler },
    ]);
    const ctrl = new ModulesDispatcherController(router, makeTokens({ [VALID_TOKEN]: claims() }), httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/public',
      headers: { authorization: `Basic ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);
    expect(handler.mock.calls[0][0].user).toBeNull();
  });

  it('user=null si "Bearer " va seguido de string vacío', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/public', handler },
    ]);
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/public',
      headers: { authorization: 'Bearer    ' },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);
    expect(handler.mock.calls[0][0].user).toBeNull();
    // Y NO debe haber intentado verificar un token vacío.
    expect((tokens.verifyAccess as any)).not.toHaveBeenCalled();
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
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/boom',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();
    await expect(ctrl.dispatch(req, reply, undefined)).rejects.toBeInstanceOf(
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
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/with-headers',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply, state } = makeReply();
    await ctrl.dispatch(req, reply, undefined);
    expect(state.headers['x-mod']).toBe('example');
    expect(state.status).toBe(201);
  });

  it('handler sin body devuelve 204', async () => {
    const router = new ModuleRouterService();
    router.registerModule('mod.example', '/modules/example', [
      { method: 'DELETE', path: '/x', handler: async () => undefined as never },
    ]);
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/x',
      method: 'DELETE',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply, state } = makeReply();
    await ctrl.dispatch(req, reply, undefined);
    expect(state.status).toBe(204);
  });

  // Contrato `ctx.http` (alpha.49 task 5): el handler SIEMPRE recibe un
  // cliente HTTP saliente. Cuando el módulo NO declara `manifest.http`,
  // el dispatcher inyecta `BlockedSandboxedHttp` que rechaza toda URL
  // con HTTP_BLOCKED_HOST y mensaje claro. Esto fuerza al dev a declarar
  // la salida HTTP en el manifest antes de poder usarla.
  it('módulo sin manifest.http → ctx.http es BlockedSandboxedHttp', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/probe', handler },
    ]);
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/probe',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);

    const ctx = handler.mock.calls[0][0];
    expect(typeof ctx.http?.get).toBe('function');
    expect(typeof ctx.http?.post).toBe('function');

    await expect(ctx.http.get('https://api.zoom.us/x')).rejects.toMatchObject({
      name: 'HttpError',
      code: 'HTTP_BLOCKED_HOST',
    });
  });

  // Contrato cuando el módulo SÍ declara `manifest.http`: el dispatcher
  // arma RateLimitedHttp(SandboxedHttpService.build(...)) — allowlist
  // + SSRF + rate limit. Verificamos que invocar un host válido fuera
  // de la allowlist devuelve HTTP_BLOCKED_HOST (no Noop, no garbage).
  it('módulo con manifest.http restrictivo → ctx.http aplica allowlist', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule(
      'mod.zoom',
      '/modules/zoom',
      [{ method: 'GET', path: '/probe', handler }],
      {
        httpConfig: {
          allowedHosts: ['api.zoom.us'],
          rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
          maxBodyBytes: 1024,
        },
      },
    );
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/zoom/probe',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);

    const ctx = handler.mock.calls[0][0];
    // Host fuera de allowlist → HTTP_BLOCKED_HOST
    await expect(ctx.http.get('https://otro.host.com/x')).rejects.toMatchObject({
      code: 'HTTP_BLOCKED_HOST',
    });
  });

  // Contrato `ctx.db` (alpha.51 task DB-004): el handler SIEMPRE recibe
  // un cliente de BD. Si el módulo NO declara `requiresDb: true` → recibe
  // BlockedSandboxedDb que rechaza con DB_PREFIX_VIOLATION explicando
  // cómo activarlo. Si lo declara → recibe SandboxedDbService.build(...)
  // scoped al tablePrefix + tenantId del request.
  it('módulo sin requiresDb → ctx.db es BlockedSandboxedDb', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/probe', handler },
    ]);
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/probe',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);

    const ctx = handler.mock.calls[0][0];
    expect(typeof ctx.db?.query).toBe('function');
    expect(typeof ctx.db?.execute).toBe('function');
    expect(typeof ctx.db?.transaction).toBe('function');

    await expect(ctx.db.query('SELECT 1 FROM mod_example_jobs')).rejects.toMatchObject({
      name: 'DbError',
      code: 'DB_PREFIX_VIOLATION',
      message: expect.stringContaining('requiresDb'),
    });
  });

  it('módulo con requiresDb=true → ctx.db ejecuta queries scoped (con SQL guard activo)', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule(
      'mod.example',
      '/modules/example',
      [{ method: 'GET', path: '/probe', handler }],
      {
        dbEnabled: true,
        tablePrefix: 'mod_example_',
      },
    );
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/probe',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);

    const ctx = handler.mock.calls[0][0];
    // Query dentro del prefix → pasa el guard, llega al fakePrisma stub.
    await expect(ctx.db.query('SELECT * FROM mod_example_jobs')).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
    // Query fuera del prefix → DB_PREFIX_VIOLATION (SQL guard).
    await expect(ctx.db.query('SELECT * FROM "user"')).rejects.toMatchObject({
      code: 'DB_PREFIX_VIOLATION',
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Regresión DD-003 (alpha.52): cableado de ctx.didacta
  // ─────────────────────────────────────────────────────────────────────────

  it('módulo SIN bloque didacta → ctx.didacta rechaza con DIDACTA_PERMISSION_DENIED', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/probe', handler },
    ]);
    const tokens = makeTokens({ [VALID_TOKEN]: claims() });
    const ctrl = new ModulesDispatcherController(router, tokens, httpSvc, rateLimiter, dbSvc, didactaFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/probe',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);

    const ctx = handler.mock.calls[0][0];
    expect(typeof ctx.didacta?.users?.upsertByExternalRef).toBe('function');

    await expect(
      ctx.didacta.users.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        email: 'a@b.com',
      }),
    ).rejects.toMatchObject({
      name: 'DidactaError',
      code: 'DIDACTA_PERMISSION_DENIED',
      message: expect.stringContaining('manifest'),
    });
  });

  it('módulo CON bloque didacta → llamada llega al ScopedDidactaApiFactory.build (con permisos)', async () => {
    const router = new ModuleRouterService();
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    router.registerModule(
      'mod.example',
      '/modules/example',
      [{ method: 'GET', path: '/probe', handler }],
      {
        didactaConfig: {
          externalSource: 'learndash',
          permissions: ['users.upsertByExternalRef'],
        },
      },
    );
    // Stub: factory.build devuelve un cliente de prueba que graba la
    // invocación. Verifica que el dispatcher pasó moduleId + didactaConfig.
    const buildSpy = vi.fn(() => ({
      users: {
        upsertByExternalRef: vi.fn(async () => ({ id: 'u-1' } as any)),
      },
    }));
    const fakeFactory = { build: buildSpy } as any;
    const ctrl = new ModulesDispatcherController(router, makeTokens({ [VALID_TOKEN]: claims() }), httpSvc, rateLimiter, dbSvc, fakeFactory, jobsFactory, secretsFactory, moduleRegistry, contextFactory, tenantContext);
    const req = makeReq({
      url: '/api/v1/modules/example/probe',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { reply } = makeReply();
    await ctrl.dispatch(req, reply, undefined);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy.mock.calls[0][0]).toBe('mod.example');
    expect(buildSpy.mock.calls[0][1]).toEqual({
      externalSource: 'learndash',
      permissions: ['users.upsertByExternalRef'],
    });
  });
});
