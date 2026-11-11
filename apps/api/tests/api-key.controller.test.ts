import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApiKeysController } from '../src/admin/admin-api-keys.controller';
import { ALLOWED_API_KEY_SCOPES } from '../src/auth/api-key-scopes';
import { ApiKeyController } from '../src/auth/api-key.controller';
import { ApiKeyService } from '../src/auth/api-key.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { TokenService } from '../src/auth/token.service';
import { PrismaAuditLogService } from '../src/modules/prisma-audit-log.service';

/**
 * `/auth/api-keys` y `/admin/api-keys` — regresión de la escalada de privilegios.
 *
 * Antes, en `/auth/api-keys` bastaba con estar logueado: un ALUMNO podía
 * acuñarse una API key con `enrollments:write` u `orders:*` y, con ella,
 * matricularse en cualquier curso de pago o leer compras del aula. Y como el
 * guard de API keys copia los scopes a `roles`, también podía pedir un «scope»
 * `tenant_admin`.
 *
 * El test pasa por HTTP de verdad (Fastify + `JwtAuthGuard` + `TokenService`
 * reales, con JWT firmados) para cubrir guard, pipe de validación y handler
 * juntos. Solo `ApiKeyService` y el audit log son falsos: así se comprueba
 * además que, cuando se rechaza, NO se llega a escribir nada.
 *
 * Los dos controllers se prueban con la misma tabla a propósito: son dos
 * puertas al mismo almacén y tienen que pedir lo mismo.
 */

const TENANT = 'tenant-A';

const apiKeys = {
  create: vi.fn(async (p: { name: string; scopes: string[] }) => ({
    id: 'key-1',
    name: p.name,
    token: 'lmsk_test',
    scopes: p.scopes,
    createdAt: new Date('2026-09-28T00:00:00Z'),
    expiresAt: null,
  })),
  listForUser: vi.fn(async () => []),
  listForTenant: vi.fn(async () => []),
  revoke: vi.fn(async () => undefined),
  revokeForTenant: vi.fn(async () => undefined),
};
const auditLog = { record: vi.fn(async () => undefined) };

@Module({
  controllers: [ApiKeyController, AdminApiKeysController],
  providers: [
    TokenService,
    JwtAuthGuard,
    { provide: ApiKeyService, useValue: apiKeys },
    { provide: PrismaAuditLogService, useValue: auditLog },
  ],
})
class ApiKeyTestModule {}

let app: NestFastifyApplication;
let tokens: TokenService;

const ORIGINAL_SECRET = process.env['AUTH_SECRET'];
const ORIGINAL_MFA = process.env['DIDACTA_REQUIRE_MFA_ADMIN'];

async function bearer(roles: string[], sub = 'user-1'): Promise<string> {
  const signed = await tokens.sign({ sub, tenantId: TENANT, roles, mfaVerified: true });
  return `Bearer ${signed.accessToken}`;
}

const ROUTES = ['/api/v1/auth/api-keys', '/api/v1/admin/api-keys'] as const;

function post(url: string, auth: string | null, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: auth ? { authorization: auth } : {},
    payload: payload as Record<string, unknown>,
  });
}
function list(url: string, auth: string | null) {
  return app.inject({ method: 'GET', url, headers: auth ? { authorization: auth } : {} });
}
function revoke(url: string, auth: string | null) {
  return app.inject({
    method: 'DELETE',
    url: `${url}/key-1`,
    headers: auth ? { authorization: auth } : {},
  });
}

function nothingWritten() {
  expect(apiKeys.create).not.toHaveBeenCalled();
  expect(apiKeys.listForUser).not.toHaveBeenCalled();
  expect(apiKeys.listForTenant).not.toHaveBeenCalled();
  expect(apiKeys.revoke).not.toHaveBeenCalled();
  expect(apiKeys.revokeForTenant).not.toHaveBeenCalled();
  expect(auditLog.record).not.toHaveBeenCalled();
}

const VALID_BODY = { name: 'n8n', scopes: ['enrollments:write', 'courses:read'] };

beforeAll(async () => {
  process.env['AUTH_SECRET'] = 'test-secret-de-al-menos-32-caracteres-0123456789';
  delete process.env['DIDACTA_REQUIRE_MFA_ADMIN'];
  app = await NestFactory.create<NestFastifyApplication>(ApiKeyTestModule, new FastifyAdapter(), {
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
  if (ORIGINAL_MFA === undefined) delete process.env['DIDACTA_REQUIRE_MFA_ADMIN'];
  else process.env['DIDACTA_REQUIRE_MFA_ADMIN'] = ORIGINAL_MFA;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(ROUTES)('%s', (url) => {
  it('sin sesión → 401 en POST, GET y DELETE', async () => {
    expect((await post(url, null, VALID_BODY)).statusCode).toBe(401);
    expect((await list(url, null)).statusCode).toBe(401);
    expect((await revoke(url, null)).statusCode).toBe(401);
    nothingWritten();
  });

  it.each([
    ['alumno', ['alumno']],
    ['formador', ['formador']],
    ['formador + alumno', ['formador', 'alumno']],
    ['sin roles', []],
  ])('%s → 403 al crear, listar y revocar, y no se escribe nada', async (_label, roles) => {
    const auth = await bearer(roles);

    const created = await post(url, auth, VALID_BODY);
    expect(created.statusCode).toBe(403);
    expect(created.json().code).toBe('ADMIN_FORBIDDEN_ADMIN_ROLE_REQUIRED');

    expect((await list(url, auth)).statusCode).toBe(403);
    expect((await revoke(url, auth)).statusCode).toBe(403);

    nothingWritten();
  });

  it('un alumno tampoco consigue una clave con «scope» de rol (tenant_admin)', async () => {
    const res = await post(url, await bearer(['alumno']), { name: 'x', scopes: ['tenant_admin'] });
    expect([400, 403]).toContain(res.statusCode);
    nothingWritten();
  });

  it('un alumno no consigue una clave con todos los scopes del catálogo', async () => {
    const res = await post(url, await bearer(['alumno']), {
      name: 'x',
      scopes: [...ALLOWED_API_KEY_SCOPES],
    });
    expect(res.statusCode).toBe(403);
    nothingWritten();
  });

  it.each([
    ['tenant_admin', ['tenant_admin']],
    ['super_admin', ['super_admin']],
    ['formador + tenant_admin', ['formador', 'tenant_admin']],
  ])('%s → crea (201), lista (200) y revoca (204)', async (_label, roles) => {
    const auth = await bearer(roles, 'admin-1');

    const created = await post(url, auth, VALID_BODY);
    expect(created.statusCode).toBe(201);
    expect(created.json().token).toBe('lmsk_test');
    expect(apiKeys.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        userId: 'admin-1',
        scopes: ['enrollments:write', 'courses:read'],
      }),
    );

    expect((await list(url, auth)).statusCode).toBe(200);
    expect((await revoke(url, auth)).statusCode).toBe(204);
  });

  it('acepta cualquier scope del catálogo', async () => {
    const res = await post(url, await bearer(['tenant_admin']), {
      name: 'todo',
      scopes: [...ALLOWED_API_KEY_SCOPES],
    });
    expect(res.statusCode).toBe(201);
  });

  it.each([['tenant_admin'], ['super_admin'], ['formador'], ['inventado:write']])(
    'ni un super_admin acuña el scope «%s»: 400 y no se crea',
    async (scope) => {
      const res = await post(url, await bearer(['super_admin']), { name: 'x', scopes: [scope] });
      expect(res.statusCode).toBe(400);
      expect(apiKeys.create).not.toHaveBeenCalled();
    },
  );

  it('crear y revocar dejan rastro en el audit log, entren por donde entren', async () => {
    const auth = await bearer(['tenant_admin'], 'admin-1');

    await post(url, auth, VALID_BODY);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: 'admin-1',
        action: 'admin.api_key.created',
        resourceId: 'key-1',
        metadata: { name: 'n8n', scopes: ['enrollments:write', 'courses:read'] },
      }),
    );

    await revoke(url, auth);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: 'admin-1',
        action: 'admin.api_key.revoked',
        resourceId: 'key-1',
      }),
    );
  });
});

describe('alcance de cada puerta', () => {
  it('/auth/api-keys lista y revoca solo las claves del admin que llama', async () => {
    const auth = await bearer(['tenant_admin'], 'admin-1');
    await list('/api/v1/auth/api-keys', auth);
    await revoke('/api/v1/auth/api-keys', auth);
    expect(apiKeys.listForUser).toHaveBeenCalledWith(TENANT, 'admin-1');
    expect(apiKeys.revoke).toHaveBeenCalledWith(TENANT, 'admin-1', 'key-1');
    expect(apiKeys.listForTenant).not.toHaveBeenCalled();
    expect(apiKeys.revokeForTenant).not.toHaveBeenCalled();
  });

  it('/admin/api-keys lista y revoca las de todo el tenant', async () => {
    const auth = await bearer(['tenant_admin'], 'admin-1');
    await list('/api/v1/admin/api-keys', auth);
    await revoke('/api/v1/admin/api-keys', auth);
    expect(apiKeys.listForTenant).toHaveBeenCalledWith(TENANT);
    expect(apiKeys.revokeForTenant).toHaveBeenCalledWith(TENANT, 'key-1');
    expect(apiKeys.listForUser).not.toHaveBeenCalled();
    expect(apiKeys.revoke).not.toHaveBeenCalled();
  });
});
