/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del OidcAdminController — 8º piloto License SDK (`feat:sso.oidc`).
 *
 * Cobertura:
 *   - GET sin user en req → UnauthorizedException.
 *   - GET con user no admin (rol student) → ForbiddenException.
 *   - GET con admin pero sin config → { exists: false, redirectUri }.
 *   - GET con admin y config → { exists: true, config } sin clientSecret.
 *   - PUT con admin: delega a service.setConfig + audit log entry adicional.
 *   - PUT marca rotatedSecret=true en metadata cuando se incluye clientSecret.
 *   - DELETE existente → audit log entry "config_deleted".
 *   - DELETE inexistente → no escribe audit log adicional.
 *   - test-discovery delega a service.testDiscovery con el issuer del DTO.
 *
 * El gating @RequiresCapability(SSO_OIDC) se prueba en la suite integration
 * LicenseGuard end-to-end (fuera de scope de unit tests).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { OidcAdminController } from '../src/admin/sso/oidc-admin.controller';
import type { SessionClaims } from '../src/auth/token.service';
import { LICENSE_CAPABILITIES } from '@didacta/license-sdk';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeOidcService {
  getSafeConfig: ReturnType<typeof vi.fn>;
  setConfig: ReturnType<typeof vi.fn>;
  deleteConfig: ReturnType<typeof vi.fn>;
  testDiscovery: ReturnType<typeof vi.fn>;
  __redirectUriForTest: string;
}

function makeFakeOidcService(): FakeOidcService {
  return {
    getSafeConfig: vi.fn(),
    setConfig: vi.fn(),
    deleteConfig: vi.fn(),
    testDiscovery: vi.fn(),
    __redirectUriForTest: 'http://localhost:4000/api/v1/auth/oidc/callback',
  };
}

function makeFakeAuditLog() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    _entries: entries,
    record: vi.fn(async (entry: Record<string, unknown>) => {
      entries.push(entry);
    }),
  };
}

function adminUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'admin-1',
    tenantId: 'tenant-1',
    roles: ['tenant_admin'],
    mfaVerified: true,
    ...overrides,
  };
}

function fakeReq(): Parameters<OidcAdminController['setConfig']>[0] {
  return {
    headers: { 'user-agent': 'vitest', 'x-forwarded-for': '127.0.0.1' },
  } as unknown as Parameters<OidcAdminController['setConfig']>[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET config
// ---------------------------------------------------------------------------

describe('OidcAdminController.getConfig', () => {
  it('lanza UnauthorizedException si no hay user', async () => {
    const svc = makeFakeOidcService();
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    await expect(ctrl.getConfig(undefined)).rejects.toThrow(UnauthorizedException);
  });

  it('lanza ForbiddenException si user no es admin', async () => {
    const svc = makeFakeOidcService();
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    await expect(ctrl.getConfig(adminUser({ roles: ['student'] }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('exists:false con redirectUri si no hay config', async () => {
    const svc = makeFakeOidcService();
    svc.getSafeConfig.mockResolvedValue(null);
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    const result = await ctrl.getConfig(adminUser());
    expect(result).toEqual({
      exists: false,
      redirectUri: svc.__redirectUriForTest,
      capability: LICENSE_CAPABILITIES.SSO_OIDC,
    });
  });

  it('exists:true con config (sin clientSecret) si existe', async () => {
    const svc = makeFakeOidcService();
    svc.getSafeConfig.mockResolvedValue({
      enabled: true,
      issuer: 'https://idp.example.com',
      clientId: 'cid',
      hasSecret: true,
      allowedEmailDomains: ['acme.com'],
      autoProvisionUsers: true,
      scopes: ['openid', 'email'],
      redirectUri: 'http://localhost:4000/api/v1/auth/oidc/callback',
      createdAt: '2026-04-30T10:00:00.000Z',
      updatedAt: '2026-04-30T10:00:00.000Z',
    });
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    const result = await ctrl.getConfig(adminUser());
    expect(result.exists).toBe(true);
    expect((result as { config: Record<string, unknown> }).config['hasSecret']).toBe(true);
    expect((result as { config: Record<string, unknown> }).config['clientSecret']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PUT config
// ---------------------------------------------------------------------------

describe('OidcAdminController.setConfig', () => {
  it('delega a service y registra audit log con rotatedSecret=true cuando se envía secret', async () => {
    const svc = makeFakeOidcService();
    svc.setConfig.mockResolvedValue({
      enabled: true,
      issuer: 'https://idp.example.com',
      clientId: 'cid',
      hasSecret: true,
      allowedEmailDomains: [],
      autoProvisionUsers: false,
      scopes: ['openid'],
      redirectUri: '...',
      createdAt: 'x',
      updatedAt: 'y',
    });
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );

    const result = await ctrl.setConfig(fakeReq(), adminUser(), {
      enabled: true,
      issuer: 'https://idp.example.com',
      clientId: 'cid',
      clientSecret: 'plaintext-secret-1234567890',
      allowedEmailDomains: [],
      autoProvisionUsers: false,
      scopes: ['openid'],
    });

    expect(svc.setConfig).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        clientSecret: 'plaintext-secret-1234567890',
      }),
      'admin-1',
    );
    expect(al._entries).toHaveLength(1);
    expect(al._entries[0]!['action']).toBe('sso.oidc.admin.config_saved');
    expect((al._entries[0]!['metadata'] as { rotatedSecret: boolean }).rotatedSecret).toBe(true);
    expect(result.exists).toBe(true);
  });

  it('audit log marca rotatedSecret=false si el DTO no envía secret', async () => {
    const svc = makeFakeOidcService();
    svc.setConfig.mockResolvedValue({
      enabled: true,
      issuer: 'https://idp.example.com',
      clientId: 'cid',
      hasSecret: true,
      allowedEmailDomains: [],
      autoProvisionUsers: false,
      scopes: ['openid'],
      redirectUri: '...',
      createdAt: 'x',
      updatedAt: 'y',
    });
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    await ctrl.setConfig(fakeReq(), adminUser(), {
      enabled: false,
      issuer: 'https://idp.example.com',
      clientId: 'cid',
      clientSecret: null,
      allowedEmailDomains: [],
      autoProvisionUsers: false,
      scopes: ['openid'],
    });
    expect((al._entries[0]!['metadata'] as { rotatedSecret: boolean }).rotatedSecret).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DELETE config
// ---------------------------------------------------------------------------

describe('OidcAdminController.deleteConfig', () => {
  it('si había config, registra audit log "config_deleted"', async () => {
    const svc = makeFakeOidcService();
    svc.deleteConfig.mockResolvedValue({ deleted: true });
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    const result = await ctrl.deleteConfig(fakeReq(), adminUser());
    expect(result).toEqual({ deleted: true });
    expect(al._entries.some((e) => e['action'] === 'sso.oidc.admin.config_deleted')).toBe(true);
  });

  it('si no había config, no registra audit log adicional', async () => {
    const svc = makeFakeOidcService();
    svc.deleteConfig.mockResolvedValue({ deleted: false });
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    const result = await ctrl.deleteConfig(fakeReq(), adminUser());
    expect(result).toEqual({ deleted: false });
    expect(al._entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST test-discovery
// ---------------------------------------------------------------------------

describe('OidcAdminController.testDiscovery', () => {
  it('delega al service y devuelve el probe', async () => {
    const svc = makeFakeOidcService();
    svc.testDiscovery.mockResolvedValue({
      ok: true,
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/.well-known/jwks.json',
      issuer: 'https://idp.example.com',
    });
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    const result = await ctrl.testDiscovery(adminUser(), {
      issuer: 'https://idp.example.com',
    });
    expect(svc.testDiscovery).toHaveBeenCalledWith('https://idp.example.com');
    expect(result.ok).toBe(true);
  });

  it('rechaza si user no es admin', async () => {
    const svc = makeFakeOidcService();
    const al = makeFakeAuditLog();
    const ctrl = new OidcAdminController(
      svc as unknown as ConstructorParameters<typeof OidcAdminController>[0],
      al as unknown as ConstructorParameters<typeof OidcAdminController>[1],
    );
    await expect(
      ctrl.testDiscovery(adminUser({ roles: ['student'] }), {
        issuer: 'https://idp.example.com',
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});
