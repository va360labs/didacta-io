/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKeyGuard, extractAgentToken } from '../src/agent/agent-key.guard';
import { AgentKeysController } from '../src/agent/agent-keys.controller';
import { PANEL_AGENT_SCOPES } from '../src/agent/agent-scopes';
import { AGENT_TOOLS, localizeAgentText } from '../src/agent/agent-tools';
import { AgentService, AgentToolError } from '../src/agent/agent.service';
import { McpController, negotiateProtocolVersion } from '../src/agent/mcp.controller';
import { ApiKeyService } from '../src/auth/api-key.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import type { SessionClaims } from '../src/auth/token.service';
import { TokenService } from '../src/auth/token.service';
import { PrismaAuditLogService } from '../src/modules/prisma-audit-log.service';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { TenantResolverService } from '../src/tenancy/tenant-resolver.service';
import { tenantContextStorage } from '../src/tenancy/tenant-context.storage';

/**
 * Servidor MCP y clave del panel, por HTTP de verdad (Fastify + guards y pipes
 * reales). Falsos: el almacén de claves, el resolvedor de dominios, el audit
 * log y el servicio de herramientas (que tiene su propio test).
 *
 * Lo que se demuestra aquí:
 *   - el aula sale de la CLAVE: ni `Host`, ni cabeceras, ni argumentos la
 *     eligen; el dominio de otra aula solo sirve para rechazar;
 *   - sin clave de agente no hay MCP (ni con JWT de admin, ni con clave sin
 *     scopes `agent:*`);
 *   - el transporte cumple lo que piden los clientes: 200 JSON, 202 a las
 *     notificaciones, 405 a GET/DELETE, `tools/list` filtrado;
 *   - la clave del panel solo la crea un admin CON SESIÓN, con scopes fijos.
 */

const KEYS: Record<string, { id: string; tenantId: string; userId: string; scopes: string[] }> = {
  lmsk_aula_a: {
    id: 'key-a',
    tenantId: 'tenant-A',
    userId: 'owner-a',
    scopes: [...PANEL_AGENT_SCOPES],
  },
  lmsk_aula_b: {
    id: 'key-b',
    tenantId: 'tenant-B',
    userId: 'owner-b',
    scopes: ['agent:courses:read'],
  },
  lmsk_integracion: {
    id: 'key-i',
    tenantId: 'tenant-A',
    userId: 'owner-a',
    scopes: ['enrollments:write', 'tenant_admin'],
  },
};

const apiKeys = {
  findValidByToken: vi.fn(async (t: string) => KEYS[t] ?? null),
  resolveContext: vi.fn(async (t: string) => KEYS[t] ?? null),
  create: vi.fn(async (p: { name: string; scopes: string[] }) => ({
    id: 'nueva',
    name: p.name,
    token: 'lmsk_recien_creada',
    scopes: p.scopes,
    createdAt: new Date('2026-11-13T00:00:00Z'),
    expiresAt: null,
  })),
};
const DOMAINS: Record<string, { id: string }> = {
  'aula-a.example.com': { id: 'tenant-A' },
  'aula-b.example.com': { id: 'tenant-B' },
};
const resolver = {
  resolveByHost: vi.fn(async (h: string | undefined) => DOMAINS[(h ?? '').split(':')[0]!] ?? null),
};
const auditLog = { record: vi.fn(async () => undefined) };
const seen: { user?: SessionClaims; als?: string } = {};
/** Idioma del aula del doble: lo cambia el test de las instrucciones. */
let idiomaAula: 'es' | 'en' | 'pt' = 'es';
const agent = {
  academyName: vi.fn(async () => 'Aula A'),
  academyLocale: vi.fn(async (): Promise<'es' | 'en' | 'pt'> => idiomaAula),
  localize: vi.fn(async (_t: string, text: string) => localizeAgentText(text, idiomaAula)),
  visibleTools: vi.fn(async (u: SessionClaims) =>
    AGENT_TOOLS.filter((t) => u.roles.includes(t.scope)),
  ),
  call: vi.fn(async (u: SessionClaims, _k: string, name: string, args: unknown) => {
    seen.user = u;
    seen.als = tenantContextStorage.getStore()?.tenantId;
    if (name === 'falla') throw new AgentToolError('X_FAIL', 'falló a propósito');
    if (name === 'revienta') throw new Error('detalle interno con secretos');
    return { ok: true, args };
  }),
};

@Module({
  controllers: [McpController, AgentKeysController],
  providers: [
    TokenService,
    JwtAuthGuard,
    AgentKeyGuard,
    TenantContextService,
    { provide: ApiKeyService, useValue: apiKeys },
    { provide: TenantResolverService, useValue: resolver },
    { provide: PrismaAuditLogService, useValue: auditLog },
    { provide: AgentService, useValue: agent },
  ],
})
class AgentTestModule {}

let app: NestFastifyApplication;
let tokens: TokenService;
const ORIGINAL_SECRET = process.env['AUTH_SECRET'];

beforeAll(async () => {
  process.env['AUTH_SECRET'] = 'test-secret-de-al-menos-32-caracteres-0123456789';
  app = await NestFactory.create<NestFastifyApplication>(AgentTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  tokens = app.get(TokenService);
});

afterAll(async () => {
  await app.close();
  if (ORIGINAL_SECRET === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = ORIGINAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  delete seen.user;
  delete seen.als;
});

function rpc(body: unknown, auth: string | null, host = 'aula-a.example.com') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: {
      host,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: auth } : {}),
    },
    payload: JSON.stringify(body),
  });
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

describe('extractAgentToken', () => {
  it.each([
    ['Bearer lmsk_x', 'lmsk_x'],
    ['ApiKey lmsk_x', 'lmsk_x'],
    ['bearer lmsk_x ', 'lmsk_x'],
    ['Bearer eyJhbGciOi.jwt.firma', null],
    ['Basic lmsk_x', null],
    ['lmsk_x', null],
    [undefined, null],
  ])('%s → %s', (header, expected) => {
    expect(extractAgentToken(header)).toBe(expected);
  });
});

describe('MCP — quién entra', () => {
  it('sin cabecera → 401 y no se llega a ninguna herramienta', async () => {
    const res = await rpc(LIST, null);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AGENT_KEY_MISSING');
    expect(agent.visibleTools).not.toHaveBeenCalled();
  });

  it('una sesión de persona (JWT de admin) no abre el MCP', async () => {
    const jwt = await tokens.sign({
      sub: 'owner-a',
      tenantId: 'tenant-A',
      roles: ['tenant_admin'],
      mfaVerified: true,
    });
    const res = await rpc(LIST, `Bearer ${jwt.accessToken}`);
    expect(res.statusCode).toBe(401);
    expect(agent.visibleTools).not.toHaveBeenCalled();
  });

  it('clave desconocida o revocada → 401', async () => {
    const res = await rpc(LIST, 'Bearer lmsk_no_existe');
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AGENT_KEY_INVALID');
  });

  it('una clave de integración (sin scopes agent:*) → 403, aunque traiga «tenant_admin»', async () => {
    const res = await rpc(LIST, 'Bearer lmsk_integracion');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('AGENT_KEY_NOT_AGENT');
  });

  it('la clave del aula A por el dominio del aula B → 403 (el dominio solo rechaza)', async () => {
    const res = await rpc(LIST, 'Bearer lmsk_aula_a', 'aula-b.example.com');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('AGENT_KEY_OTHER_ACADEMY');
    expect(agent.visibleTools).not.toHaveBeenCalled();
  });

  it('con contexto de otra aula ya abierto → 403 (el guard, directo)', async () => {
    const guard = new AgentKeyGuard(
      apiKeys as never,
      new TenantContextService(),
      resolver as never,
    );
    const req = { headers: { authorization: 'Bearer lmsk_aula_a', host: 'x.example.com' } };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
    await expect(
      tenantContextStorage.run({ tenantId: 'tenant-B', traceId: 't' }, () =>
        guard.canActivate(ctx),
      ),
    ).rejects.toMatchObject({ response: { code: 'AGENT_KEY_OTHER_ACADEMY' } });
    // Con el contexto de SU aula, pasa.
    await expect(
      tenantContextStorage.run({ tenantId: 'tenant-A', traceId: 't' }, () =>
        guard.canActivate(ctx),
      ),
    ).resolves.toBe(true);
  });

  it('el aula sale de la clave: ni Host desconocido, ni cabeceras, ni argumentos la cambian', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: {
        host: 'dominio-sin-aula.example.com',
        'content-type': 'application/json',
        authorization: 'ApiKey lmsk_aula_a',
        'x-tenant-id': 'tenant-B',
        'x-forwarded-host': 'otro-sin-aula.example.com',
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'list_courses', arguments: { tenantId: 'tenant-B' } },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(seen.user?.tenantId).toBe('tenant-A');
    expect(seen.user?.sub).toBe('owner-a');
    expect(seen.als).toBe('tenant-A');
    // Los roles son SOLO los scopes de agente de la clave.
    expect(seen.user?.roles).toEqual([...PANEL_AGENT_SCOPES]);
  });
});

describe('MCP — protocolo', () => {
  it('initialize: negocia versión, saluda con el nombre del aula y explica los límites', async () => {
    const res = await rpc(
      {
        jsonrpc: '2.0',
        id: 'a',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } },
      },
      'Bearer lmsk_aula_a',
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const r = res.json().result;
    expect(r.protocolVersion).toBe('2025-06-18');
    expect(r.capabilities.tools).toBeDefined();
    expect(r.serverInfo.title).toContain('Aula A');
    expect(r.instructions).toMatch(/draft/);
  });

  it('initialize: la palabra con la que la interfaz llama a la academia, en su idioma («escola» en pt)', async () => {
    // Sesión real en pt-BR: el agente habló de «ferramentas da academia»
    // porque las instrucciones solo decían «academy».
    const initialize = async () =>
      (
        await rpc(
          { jsonrpc: '2.0', id: 'w', method: 'initialize', params: {} },
          'Bearer lmsk_aula_a',
        )
      ).json().result.instructions as string;
    const frase = (palabra: string) =>
      `In this academy's language the academy is called "${palabra}": use that word when talking to the user`;
    try {
      idiomaAula = 'pt';
      const pt = await initialize();
      expect(pt).toContain(frase('escola'));
      expect(pt).not.toContain('"academia"');
      idiomaAula = 'es';
      const es = await initialize();
      expect(es).toContain(frase('academia'));
      expect(es).not.toContain('"escola"');
      idiomaAula = 'en';
      const en = await initialize();
      expect(en).toContain(frase('academy'));
      expect(en).not.toMatch(/"(escola|academia)"/);
    } finally {
      idiomaAula = 'es';
    }
  });

  it('initialize: instrucciones en inglés, pero la pantalla con el nombre que ve el aula', async () => {
    const initialize = async () =>
      (
        await rpc(
          { jsonrpc: '2.0', id: 'i', method: 'initialize', params: {} },
          'Bearer lmsk_aula_a',
        )
      ).json().result.instructions as string;
    try {
      idiomaAula = 'es';
      const es = await initialize();
      expect(es).toContain('publishes them (with their price) from "Empieza aquí"');
      expect(es).not.toContain('Start here');
      expect(es).not.toContain('{{ui:');
      idiomaAula = 'en';
      const en = await initialize();
      expect(en).toContain('from "Start here"');
      expect(en).not.toContain('Empieza aquí');
      idiomaAula = 'pt';
      const pt = await initialize();
      expect(pt).toContain('from "Comece aqui"');
      expect(pt).not.toContain('Empieza aquí');
      expect(pt).not.toContain('{{ui:');
    } finally {
      idiomaAula = 'es';
    }
  });

  it('versión desconocida → responde con la más nueva que habla', () => {
    expect(negotiateProtocolVersion('1999-01-01')).toBe('2025-11-25');
    expect(negotiateProtocolVersion('2025-03-26')).toBe('2025-03-26');
    expect(negotiateProtocolVersion(undefined)).toBe('2025-11-25');
  });

  it('una notificación → 202 sin cuerpo', async () => {
    const res = await rpc(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      'Bearer lmsk_aula_a',
    );
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('GET y DELETE → 405 (sin flujo SSE ni sesiones)', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/v1/mcp',
        headers: { host: 'aula-a.example.com', authorization: 'Bearer lmsk_aula_a' },
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('POST');
    }
  });

  it('tools/list: solo las herramientas de los scopes de la clave', async () => {
    const a = (await rpc(LIST, 'Bearer lmsk_aula_a')).json().result.tools as Array<{
      name: string;
      annotations: { readOnlyHint: boolean; destructiveHint: boolean };
    }>;
    expect(a.map((t) => t.name).sort()).toEqual(AGENT_TOOLS.map((t) => t.name).sort());
    expect(a.every((t) => t.annotations.destructiveHint === false)).toBe(true);

    const b = (await rpc(LIST, 'Bearer lmsk_aula_b', 'aula-b.example.com')).json().result
      .tools as Array<{ name: string }>;
    expect(b.map((t) => t.name).sort()).toEqual(['get_course', 'list_courses']);
  });

  it('tools/call: el resultado va como texto JSON', async () => {
    const res = await rpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_courses', arguments: { status: 'DRAFT' } },
      },
      'Bearer lmsk_aula_a',
    );
    const r = res.json().result;
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, args: { status: 'DRAFT' } });
  });

  it('un fallo de la herramienta vuelve como isError legible; lo inesperado no filtra detalles', async () => {
    const legible = (
      await rpc(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'falla' } },
        'Bearer lmsk_aula_a',
      )
    ).json().result;
    expect(legible.isError).toBe(true);
    expect(legible.content[0].text).toContain('falló a propósito (X_FAIL)');

    const interno = (
      await rpc(
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'revienta' } },
        'Bearer lmsk_aula_a',
      )
    ).json().result;
    expect(interno.isError).toBe(true);
    expect(interno.content[0].text).not.toContain('secretos');
  });

  it('método desconocido → -32601; mensaje mal formado → -32600', async () => {
    const a = (await rpc({ jsonrpc: '2.0', id: 9, method: 'nada' }, 'Bearer lmsk_aula_a')).json();
    expect(a.error.code).toBe(-32601);
    const b = (await rpc({ id: 9 }, 'Bearer lmsk_aula_a')).json();
    expect(b.error.code).toBe(-32600);
  });

  it('lote: responde a las peticiones y calla a las notificaciones', async () => {
    const res = await rpc(
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ],
      'Bearer lmsk_aula_a',
    );
    expect(res.json()).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });
});

describe('POST /agent/keys — la clave del panel', () => {
  async function bearer(roles: string[]) {
    const s = await tokens.sign({ sub: 'owner-a', tenantId: 'tenant-A', roles, mfaVerified: true });
    return `Bearer ${s.accessToken}`;
  }
  function create(auth: string | null, payload: unknown = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/agent/keys',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      payload: JSON.stringify(payload),
    });
  }

  it('sin sesión → 401; con una clave de API (ni la de agente) → 401', async () => {
    expect((await create(null)).statusCode).toBe(401);
    expect((await create('ApiKey lmsk_aula_a')).statusCode).toBe(401);
    expect((await create('Bearer lmsk_aula_a')).statusCode).toBe(401);
    expect(apiKeys.create).not.toHaveBeenCalled();
  });

  it.each([[['alumno']], [['formador']], [[]]])('rol %j → 403 y no se crea', async (roles) => {
    expect((await create(await bearer(roles))).statusCode).toBe(403);
    expect(apiKeys.create).not.toHaveBeenCalled();
  });

  it('el cliente no puede pedir scopes: 400', async () => {
    const res = await create(await bearer(['tenant_admin']), { scopes: ['orders:read'] });
    expect(res.statusCode).toBe(400);
    expect(apiKeys.create).not.toHaveBeenCalled();
  });

  it('admin → 201 con el token una vez, scopes fijos de agente y rastro en auditoría', async () => {
    const res = await create(await bearer(['tenant_admin']));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBe('lmsk_recien_creada');
    expect(body.mcpPath).toBe('/api/v1/mcp');
    expect(apiKeys.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-A',
        userId: 'owner-a',
        scopes: [...PANEL_AGENT_SCOPES],
      }),
    );
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.api_key.created',
        metadata: expect.objectContaining({ purpose: 'agent' }),
      }),
    );
  });

  it('sin nombre, la clave se llama como en el idioma del aula', async () => {
    agent.academyLocale.mockResolvedValueOnce('en');
    expect((await create(await bearer(['tenant_admin']))).statusCode).toBe(201);
    expect(apiKeys.create).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'AI agent' }));
    expect(agent.academyLocale).toHaveBeenCalledWith('tenant-A');

    agent.academyLocale.mockResolvedValueOnce('es');
    await create(await bearer(['tenant_admin']));
    expect(apiKeys.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Agente de IA' }),
    );

    // En portugués se escribe igual que en español.
    agent.academyLocale.mockResolvedValueOnce('pt');
    await create(await bearer(['tenant_admin']));
    expect(apiKeys.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Agente de IA' }),
    );

    // Si no puede saberlo, español (el idioma por defecto del aula); un nombre
    // explícito manda siempre.
    agent.academyLocale.mockRejectedValueOnce(new Error('sin base'));
    await create(await bearer(['tenant_admin']));
    expect(apiKeys.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Agente de IA' }),
    );
    await create(await bearer(['tenant_admin']), { name: 'Mi Claude' });
    expect(apiKeys.create).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Mi Claude' }));
  });
});
