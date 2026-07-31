/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del ScimController y del ScimAuthGuard — séptimo piloto License SDK.
 *
 * Cobertura:
 *   - ScimAuthGuard:
 *     - Sin Authorization header → 401 SCIM error.
 *     - Bearer vacío → 401 SCIM error.
 *     - Bearer no reconocido → 401 SCIM error.
 *     - Bearer reconocido → resuelve tenantId en req.scimTenantId.
 *     - Token de tenant A no resuelve tenant B (aislamiento).
 *
 *   - ScimController:
 *     - ServiceProviderConfig / ResourceTypes / Schemas son siempre accesibles
 *       (no llevan @RequiresCapability — discovery RFC 7644 §4).
 *     - listUsers / createUser delegan al service con el tenantId resuelto.
 *     - sin tenantId resuelto en req → UnauthorizedException defensiva.
 *
 *   - Gating: el controller declara @RequiresCapability(SCIM); ese gate lo
 *     prueba la suite de integration LicenseGuard end-to-end (no aquí).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { hashScimToken, ScimAuthGuard } from '../src/scim/scim-auth.guard';
import { ScimController } from '../src/scim/scim.controller';
import { ScimService } from '../src/scim/scim.service';
import { SCIM_SCHEMAS, SCIM_TOKEN_KEY, SCIM_TOKEN_MODULE_NAME } from '../src/scim/scim.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrismaWithTokens(tokens: Array<{ tenantId: string; tokenHash: string }>) {
  return {
    tenantSetting: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Devuelve filas con shape { tenantId, valueJson } como espera el guard.
        // Filtramos por module/key si los pasa.
        const rows = tokens
          .filter(() => {
            // El guard filtra por moduleName=scim, key=api-token, isSecret=false
            const moduleName = where['moduleName'];
            const key = where['key'];
            return moduleName === SCIM_TOKEN_MODULE_NAME && key === SCIM_TOKEN_KEY;
          })
          .map((t) => ({
            tenantId: t.tenantId,
            valueJson: {
              tokenHash: t.tokenHash,
              prefix: 'scim_xxxxxxxx',
              createdAt: '2026-04-01T10:00:00Z',
              lastUsedAt: null,
            },
          }));
        return rows;
      }),
    },
  };
}

function makeExecutionContext(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as Parameters<ScimAuthGuard['canActivate']>[0];
}

// ---------------------------------------------------------------------------
// ScimAuthGuard
// ---------------------------------------------------------------------------

describe('ScimAuthGuard', () => {
  it('rechaza request sin Authorization header con 401 SCIM', async () => {
    const prisma = makePrismaWithTokens([]);
    const guard = new ScimAuthGuard(
      prisma as unknown as ConstructorParameters<typeof ScimAuthGuard>[0],
    );
    const ctx = makeExecutionContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza request con Bearer vacío', async () => {
    const prisma = makePrismaWithTokens([]);
    const guard = new ScimAuthGuard(
      prisma as unknown as ConstructorParameters<typeof ScimAuthGuard>[0],
    );
    const ctx = makeExecutionContext({ headers: { authorization: 'Bearer ' } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza esquema distinto a Bearer (Basic, ApiKey)', async () => {
    const prisma = makePrismaWithTokens([]);
    const guard = new ScimAuthGuard(
      prisma as unknown as ConstructorParameters<typeof ScimAuthGuard>[0],
    );
    const ctx = makeExecutionContext({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza Bearer no reconocido (hash no matchea ningún tenant)', async () => {
    const prisma = makePrismaWithTokens([
      { tenantId: 'tenant-1', tokenHash: hashScimToken('scim_realtoken') },
    ]);
    const guard = new ScimAuthGuard(
      prisma as unknown as ConstructorParameters<typeof ScimAuthGuard>[0],
    );
    const ctx = makeExecutionContext({
      headers: { authorization: 'Bearer scim_falso' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('Bearer válido inyecta tenantId en req.scimTenantId', async () => {
    const realToken = 'scim_real_token_with_enough_entropy';
    const prisma = makePrismaWithTokens([
      { tenantId: 'tenant-1', tokenHash: hashScimToken(realToken) },
    ]);
    const guard = new ScimAuthGuard(
      prisma as unknown as ConstructorParameters<typeof ScimAuthGuard>[0],
    );
    const req: Record<string, unknown> = {
      headers: { authorization: `Bearer ${realToken}` },
    };
    const ctx = makeExecutionContext(req);
    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);
    expect(req['scimTenantId']).toBe('tenant-1');
  });

  it('aislamiento: el token del tenant A NO resuelve al tenant B', async () => {
    const tokenA = 'scim_token_tenant_A';
    const tokenB = 'scim_token_tenant_B';
    const prisma = makePrismaWithTokens([
      { tenantId: 'tenant-A', tokenHash: hashScimToken(tokenA) },
      { tenantId: 'tenant-B', tokenHash: hashScimToken(tokenB) },
    ]);
    const guard = new ScimAuthGuard(
      prisma as unknown as ConstructorParameters<typeof ScimAuthGuard>[0],
    );
    const reqA: Record<string, unknown> = {
      headers: { authorization: `Bearer ${tokenA}` },
    };
    await guard.canActivate(makeExecutionContext(reqA));
    expect(reqA['scimTenantId']).toBe('tenant-A');

    const reqB: Record<string, unknown> = {
      headers: { authorization: `Bearer ${tokenB}` },
    };
    await guard.canActivate(makeExecutionContext(reqB));
    expect(reqB['scimTenantId']).toBe('tenant-B');
  });
});

describe('hashScimToken', () => {
  it('es determinista: mismo input → mismo hash', () => {
    const a = hashScimToken('scim_abc');
    const b = hashScimToken('scim_abc');
    expect(a).toBe(b);
  });

  it('inputs distintos → hashes distintos', () => {
    const a = hashScimToken('scim_abc');
    const b = hashScimToken('scim_abd');
    expect(a).not.toBe(b);
  });

  it('hash es sha256 hex (64 chars)', () => {
    const h = hashScimToken('cualquier-cosa');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// ScimController — discovery endpoints
// ---------------------------------------------------------------------------

describe('ScimController · discovery (sin gating de capability)', () => {
  let controller: ScimController;

  beforeEach(() => {
    // El service no se invoca en discovery; pasamos un stub vacío.
    const service = {} as unknown as ScimService;
    controller = new ScimController(service);
  });

  it('GET /ServiceProviderConfig devuelve los flags estándar SCIM 2.0', () => {
    const r = controller.serviceProviderConfig() as Record<string, unknown>;
    expect((r['schemas'] as string[])[0]).toBe(SCIM_SCHEMAS.SERVICE_PROVIDER_CONFIG);
    expect((r['patch'] as { supported: boolean }).supported).toBe(true);
    expect((r['bulk'] as { supported: boolean }).supported).toBe(false);
    expect((r['filter'] as { supported: boolean }).supported).toBe(true);
    const schemes = r['authenticationSchemes'] as Array<{ type: string; primary: boolean }>;
    expect(schemes[0]?.type).toBe('oauthbearertoken');
    expect(schemes[0]?.primary).toBe(true);
  });

  it('GET /ResourceTypes lista solo "User" (sin Groups en este piloto)', () => {
    const r = controller.resourceTypes() as Record<string, unknown>;
    expect(r['totalResults']).toBe(1);
    const resources = r['Resources'] as Array<{ id: string; endpoint: string }>;
    expect(resources[0]?.id).toBe('User');
    expect(resources[0]?.endpoint).toBe('/Users');
  });

  it('GET /Schemas devuelve los atributos del schema User core', () => {
    const r = controller.schemas() as Record<string, unknown>;
    const resources = r['Resources'] as Array<{ id: string; attributes: Array<{ name: string }> }>;
    expect(resources[0]?.id).toBe(SCIM_SCHEMAS.USER);
    const attrNames = resources[0]?.attributes.map((a) => a.name);
    expect(attrNames).toContain('userName');
    expect(attrNames).toContain('active');
    expect(attrNames).toContain('emails');
    expect(attrNames).toContain('name');
  });
});

// ---------------------------------------------------------------------------
// ScimController · CRUD endpoints (delegando al service)
// ---------------------------------------------------------------------------

describe('ScimController · CRUD endpoints', () => {
  function makeService() {
    return {
      listUsers: vi.fn(),
      getUser: vi.fn(),
      createUser: vi.fn(),
      patchUser: vi.fn(),
      deleteUser: vi.fn(),
    };
  }

  it('listUsers: pasa tenantId resuelto + query al service', async () => {
    const service = makeService();
    service.listUsers.mockResolvedValue({
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      resources: [],
    });
    const controller = new ScimController(service as unknown as ScimService);
    const req = { scimTenantId: 'tenant-A' } as Parameters<ScimController['listUsers']>[0];
    const out = await controller.listUsers(req, { startIndex: 1, count: 50 });
    expect(service.listUsers).toHaveBeenCalledWith('tenant-A', { startIndex: 1, count: 50 });
    expect(out.schemas[0]).toBe(SCIM_SCHEMAS.LIST_RESPONSE);
  });

  it('listUsers: sin tenantId en req → UnauthorizedException defensiva', async () => {
    const service = makeService();
    const controller = new ScimController(service as unknown as ScimService);
    const req = {} as Parameters<ScimController['listUsers']>[0];
    await expect(controller.listUsers(req, { startIndex: 1, count: 50 })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(service.listUsers).not.toHaveBeenCalled();
  });

  it('createUser: pasa tenantId resuelto + dto al service', async () => {
    const service = makeService();
    service.createUser.mockResolvedValue({ id: 'u1', userName: 'a@b.com' });
    const controller = new ScimController(service as unknown as ScimService);
    const req = { scimTenantId: 'tenant-A' } as Parameters<ScimController['createUser']>[0];
    await controller.createUser(req, { userName: 'a@b.com', active: true });
    expect(service.createUser).toHaveBeenCalledWith(
      'tenant-A',
      expect.objectContaining({ userName: 'a@b.com' }),
      { actorId: null },
    );
  });

  it('patchUser: pasa params al service', async () => {
    const service = makeService();
    service.patchUser.mockResolvedValue({ id: 'u1' });
    const controller = new ScimController(service as unknown as ScimService);
    const req = { scimTenantId: 'tenant-A' } as Parameters<ScimController['patchUser']>[0];
    await controller.patchUser(req, 'u1', {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(service.patchUser).toHaveBeenCalledWith(
      'tenant-A',
      'u1',
      expect.objectContaining({ Operations: expect.any(Array) }),
      { actorId: null },
    );
  });

  it('deleteUser: pasa params + devuelve null (204)', async () => {
    const service = makeService();
    service.deleteUser.mockResolvedValue(undefined);
    const controller = new ScimController(service as unknown as ScimService);
    const req = { scimTenantId: 'tenant-A' } as Parameters<ScimController['deleteUser']>[0];
    const out = await controller.deleteUser(req, 'u1');
    expect(service.deleteUser).toHaveBeenCalledWith('tenant-A', 'u1', { actorId: null });
    expect(out).toBeNull();
  });
});
