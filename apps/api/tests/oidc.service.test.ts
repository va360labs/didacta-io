/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del OidcService — 8º piloto License SDK (`feat:sso.oidc`).
 *
 * Cobertura mínima:
 *   - getConfig devuelve null si no hay config / corrupta.
 *   - setConfig cifra el clientSecret (no aparece en el record raw del
 *     fake tenant_setting si lo escribimos como plano sería un test inválido —
 *     usamos el FakeTenantConfig que sí persiste en plain pero verificamos que
 *     el service llamó a `set` con `isSecret: true`).
 *   - setConfig sin secret previo y sin secret en DTO → 400.
 *   - setConfig con secret previo y sin secret en DTO → preserva.
 *   - deleteConfig idempotente (segundo delete devuelve { deleted: false }).
 *   - testDiscovery OK / falla.
 *   - startFlow rechaza tenant inexistente / sin config / config disabled.
 *   - startFlow genera state+nonce+codeVerifier únicos (entropía).
 *   - handleCallback rechaza state desconocido / expirado.
 *   - handleCallback rechaza iss / aud / nonce mismatch.
 *   - handleCallback rechaza email no en allowedEmailDomains.
 *   - handleCallback con autoProvision=false y user no existe → reject.
 *   - handleCallback con autoProvision=true crea user con role student.
 *   - handleCallback rechaza error explícito del IdP.
 *   - handleCallback con user inactivo → reject.
 *   - tenant isolation: state de tenant A no resuelve tenant B (porque el
 *     flow guardado lleva tenantId).
 *   - flowStore consume el state una sola vez (defensa replay).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OidcService } from '../src/sso/oidc/oidc.service';
import {
  OIDC_CONFIG_KEY,
  OIDC_CONFIG_MODULE_NAME,
  type TenantOidcConfig,
} from '../src/sso/oidc/oidc.types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeTenant {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
}

interface FakeUserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  passwordHash: string | null;
  lastLoginAt: Date | null;
  roles: Array<{ role: { name: string } }>;
  tenant: FakeTenant;
}

interface FakePrisma {
  _tenants: FakeTenant[];
  _users: FakeUserRow[];
  tenant: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function makeFakePrisma(): FakePrisma {
  const tenants: FakeTenant[] = [];
  const users: FakeUserRow[] = [];
  let userSeq = 0;

  return {
    _tenants: tenants,
    _users: users,
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        if (where.slug) return tenants.find((t) => t.slug === where.slug) ?? null;
        if (where.id) return tenants.find((t) => t.id === where.id) ?? null;
        return null;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where['tenantId_email']) {
          const k = where['tenantId_email'] as { tenantId: string; email: string };
          return users.find((u) => u.tenantId === k.tenantId && u.email === k.email) ?? null;
        }
        if (where['id']) {
          return users.find((u) => u.id === where['id']) ?? null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const tenantId = data['tenantId'] as string;
        const tenant = tenants.find((t) => t.id === tenantId);
        if (!tenant) throw new Error(`tenant not found in fake: ${tenantId}`);
        userSeq += 1;
        const u: FakeUserRow = {
          id: `user-${userSeq}`,
          tenantId,
          email: String(data['email']),
          name: data['name'] !== undefined ? (data['name'] as string | null) : null,
          status: (data['status'] as FakeUserRow['status']) ?? 'PENDING',
          passwordHash: (data['passwordHash'] as string | null | undefined) ?? null,
          lastLoginAt: null,
          roles: [],
          tenant,
        };
        users.push(u);
        return u;
      }),
      update: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const u = users.find((x) => x.id === where['id']);
          if (!u) throw new Error('user not found');
          if (data['lastLoginAt']) u.lastLoginAt = data['lastLoginAt'] as Date;
          if (data['name'] !== undefined) u.name = (data['name'] as string | null) ?? null;
          return u;
        },
      ),
    },
  };
}

interface FakeTenantConfigStore {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  _records: Map<string, { value: unknown; isSecret: boolean }>;
}

function makeFakeTenantConfig(): FakeTenantConfigStore {
  const records = new Map<string, { value: unknown; isSecret: boolean }>();
  const key = (tenantId: string, m: string, k: string) => `${tenantId}::${m}::${k}`;

  return {
    _records: records,
    set: vi.fn(async (tenantId: string, m: string, k: string, value: unknown, opts?: { isSecret?: boolean }) => {
      records.set(key(tenantId, m, k), { value, isSecret: opts?.isSecret ?? false });
    }),
    get: vi.fn(async (tenantId: string, m: string, k: string) => {
      return records.get(key(tenantId, m, k))?.value;
    }),
    delete: vi.fn(async (tenantId: string, m: string, k: string) => {
      records.delete(key(tenantId, m, k));
    }),
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

function makeFakeTokens() {
  return {
    sign: vi.fn(async () => ({
      accessToken: 'access-token-fake',
      refreshToken: 'refresh-token-fake',
      expiresIn: 900,
    })),
    verifyAccess: vi.fn(),
    verifyRefresh: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Stub-able OidcService — sobreescribe los wrappers de openid-client.
// ---------------------------------------------------------------------------

interface IssuerStub {
  metadata: Record<string, unknown>;
}

interface ClientStub {
  authorizationUrl(opts: Record<string, unknown>): string;
  callback(
    redirectUri: string,
    params: { code: string; state: string },
    checks: { state: string; nonce: string; code_verifier: string },
  ): Promise<{ claims(): Record<string, unknown>; access_token?: string }>;
}

class TestOidcService extends OidcService {
  public issuerStub: IssuerStub | null = null;
  public clientStub: ClientStub | null = null;
  public discoveryFails: Error | null = null;
  public buildSpy = vi.fn<
    [unknown, { scope: string; state: string; nonce: string; codeChallenge: string }],
    string
  >((_c, p) => `https://idp.example.com/authorize?state=${p.state}&nonce=${p.nonce}&scope=${encodeURIComponent(p.scope)}`);
  public exchangeStub: ((p: {
    code: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  }) => Promise<{
    idTokenClaims: {
      sub: string;
      iss: string;
      aud: string | string[];
      exp: number;
      nonce?: string;
      email?: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      preferred_username?: string;
      email_verified?: boolean;
    };
    accessToken?: string;
  }>) | null = null;

  protected async discoverIssuer(): Promise<{ issuer: unknown; client: unknown }> {
    if (this.discoveryFails) throw this.discoveryFails;
    return { issuer: this.issuerStub, client: this.clientStub };
  }

  protected buildAuthorizationUrl(
    client: unknown,
    params: { scope: string; state: string; nonce: string; codeChallenge: string },
  ): string {
    return this.buildSpy(client, params);
  }

  protected async exchangeCode(
    _client: unknown,
    params: { code: string; state: string; nonce: string; codeVerifier: string },
  ): Promise<{ idTokenClaims: {
      sub: string;
      iss: string;
      aud: string | string[];
      exp: number;
      nonce?: string;
      email?: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      preferred_username?: string;
      email_verified?: boolean;
    }; accessToken?: string }> {
    if (!this.exchangeStub) throw new Error('exchangeStub no configurado en este test.');
    return this.exchangeStub(params);
  }
}

// ---------------------------------------------------------------------------
// Helpers de fixtures
// ---------------------------------------------------------------------------

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-abc-123';
const CLIENT_SECRET = 'super-secret-clientvalue-1234';

function fixtureConfig(overrides: Partial<TenantOidcConfig> = {}): TenantOidcConfig {
  const now = '2026-04-30T10:00:00.000Z';
  return {
    enabled: true,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowedEmailDomains: [],
    autoProvisionUsers: false,
    scopes: ['openid', 'email', 'profile'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setupService(opts?: {
  tenantId?: string;
  tenantSlug?: string;
  config?: Partial<TenantOidcConfig> | null; // null → no config
  existingUser?: { email: string; status?: FakeUserRow['status']; roles?: string[] };
}) {
  const tenantId = opts?.tenantId ?? 'tenant-1';
  const tenantSlug = opts?.tenantSlug ?? 'acme';
  const prisma = makeFakePrisma();
  const tc = makeFakeTenantConfig();
  const al = makeFakeAuditLog();
  const tokens = makeFakeTokens();

  prisma._tenants.push({ id: tenantId, slug: tenantSlug, name: 'Acme', status: 'ACTIVE' });
  if (opts?.existingUser) {
    prisma._users.push({
      id: 'user-existing',
      tenantId,
      email: opts.existingUser.email,
      name: 'Existing',
      status: opts.existingUser.status ?? 'ACTIVE',
      passwordHash: null,
      lastLoginAt: null,
      roles: (opts.existingUser.roles ?? ['student']).map((r) => ({ role: { name: r } })),
      tenant: prisma._tenants[0]!,
    });
  }

  if (opts?.config !== null) {
    const cfg = fixtureConfig(opts?.config ?? {});
    tc._records.set(`${tenantId}::${OIDC_CONFIG_MODULE_NAME}::${OIDC_CONFIG_KEY}`, {
      value: cfg,
      isSecret: true,
    });
  }

  const svc = new TestOidcService(
    prisma as unknown as ConstructorParameters<typeof OidcService>[0],
    tc as unknown as ConstructorParameters<typeof OidcService>[1],
    al as unknown as ConstructorParameters<typeof OidcService>[2],
    tokens as unknown as ConstructorParameters<typeof OidcService>[3],
  );

  svc.issuerStub = {
    metadata: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    },
  };
  svc.clientStub = {
    authorizationUrl: (opts: Record<string, unknown>) =>
      `${ISSUER}/authorize?state=${opts['state']}&nonce=${opts['nonce']}`,
    callback: vi.fn(),
  };

  return { svc, prisma, tc, al, tokens, tenantId, tenantSlug };
}

beforeEach(() => {
  delete process.env['OIDC_REDIRECT_URI'];
  delete process.env['PUBLIC_API_URL'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

describe('OidcService.getConfig', () => {
  it('devuelve null si no hay config persistida', async () => {
    const { svc, tenantId } = setupService({ config: null });
    expect(await svc.getConfig(tenantId)).toBeNull();
  });

  it('devuelve null y warn si el record está corrupto', async () => {
    const { svc, tc, tenantId } = setupService({ config: null });
    tc._records.set(`${tenantId}::${OIDC_CONFIG_MODULE_NAME}::${OIDC_CONFIG_KEY}`, {
      value: { issuer: 123 }, // tipo inválido para issuer
      isSecret: true,
    });
    expect(await svc.getConfig(tenantId)).toBeNull();
  });
});

describe('OidcService.getSafeConfig', () => {
  it('expone hasSecret pero NO el clientSecret', async () => {
    const { svc, tenantId } = setupService();
    const safe = await svc.getSafeConfig(tenantId);
    expect(safe).toBeTruthy();
    expect(safe!.hasSecret).toBe(true);
    expect((safe as Record<string, unknown>)['clientSecret']).toBeUndefined();
    expect(safe!.clientId).toBe(CLIENT_ID);
    expect(safe!.issuer).toBe(ISSUER);
    expect(safe!.redirectUri).toContain('/api/v1/auth/oidc/callback');
  });
});

describe('OidcService.setConfig', () => {
  it('persiste la config con isSecret=true (clientSecret cifrado)', async () => {
    const { svc, tc, tenantId } = setupService({ config: null });
    await svc.setConfig(
      tenantId,
      {
        enabled: true,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        allowedEmailDomains: ['acme.com'],
        autoProvisionUsers: true,
        scopes: ['openid', 'email'],
      },
      'admin-user-1',
    );
    expect(tc.set).toHaveBeenCalledTimes(1);
    const args = tc.set.mock.calls[0]!;
    expect(args[0]).toBe(tenantId);
    expect(args[1]).toBe(OIDC_CONFIG_MODULE_NAME);
    expect(args[2]).toBe(OIDC_CONFIG_KEY);
    expect(args[4]).toMatchObject({ isSecret: true, actorId: 'admin-user-1' });
    const persisted = args[3] as TenantOidcConfig;
    expect(persisted.clientSecret).toBe(CLIENT_SECRET);
    expect(persisted.allowedEmailDomains).toEqual(['acme.com']);
  });

  it('rechaza setConfig sin secret previo y sin secret en DTO', async () => {
    const { svc, tenantId } = setupService({ config: null });
    await expect(
      svc.setConfig(
        tenantId,
        {
          enabled: true,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          clientSecret: null,
          allowedEmailDomains: [],
          autoProvisionUsers: false,
          scopes: ['openid'],
        },
        'admin-user-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('preserva clientSecret previo si el DTO no envía uno', async () => {
    const { svc, tc, tenantId } = setupService();
    await svc.setConfig(
      tenantId,
      {
        enabled: false, // sólo cambia enabled
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: null,
        allowedEmailDomains: [],
        autoProvisionUsers: false,
        scopes: ['openid', 'email'],
      },
      'admin-user-1',
    );
    const persisted = tc.set.mock.calls.at(-1)![3] as TenantOidcConfig;
    expect(persisted.clientSecret).toBe(CLIENT_SECRET); // del fixture
    expect(persisted.enabled).toBe(false);
  });

  it('rotación: si DTO lleva nuevo secret, persiste el nuevo', async () => {
    const { svc, tc, tenantId } = setupService();
    const newSecret = 'rotated-secret-1234567890';
    await svc.setConfig(
      tenantId,
      {
        enabled: true,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: newSecret,
        allowedEmailDomains: [],
        autoProvisionUsers: false,
        scopes: ['openid', 'email'],
      },
      'admin-user-1',
    );
    const persisted = tc.set.mock.calls.at(-1)![3] as TenantOidcConfig;
    expect(persisted.clientSecret).toBe(newSecret);
  });
});

describe('OidcService.deleteConfig', () => {
  it('borra la config y registra audit log', async () => {
    const { svc, tc, al, tenantId } = setupService();
    const result = await svc.deleteConfig(tenantId, 'admin-1');
    expect(result.deleted).toBe(true);
    expect(tc.delete).toHaveBeenCalledTimes(1);
    expect(al._entries.some((e) => e['action'] === 'sso.oidc.config.deleted')).toBe(true);
  });

  it('idempotente: segundo delete devuelve { deleted: false } sin tocar nada', async () => {
    const { svc, tc, tenantId } = setupService({ config: null });
    const result = await svc.deleteConfig(tenantId, 'admin-1');
    expect(result.deleted).toBe(false);
    expect(tc.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// testDiscovery
// ---------------------------------------------------------------------------

describe('OidcService.testDiscovery', () => {
  it('OK con metadata completa', async () => {
    const { svc } = setupService();
    const result = await svc.testDiscovery(ISSUER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authorizationEndpoint).toBe(`${ISSUER}/authorize`);
      expect(result.tokenEndpoint).toBe(`${ISSUER}/token`);
      expect(result.jwksUri).toBe(`${ISSUER}/.well-known/jwks.json`);
    }
  });

  it('fail si discovery throws', async () => {
    const { svc } = setupService();
    svc.discoveryFails = new Error('connect ECONNREFUSED idp.example.com:443');
    const result = await svc.testDiscovery(ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('ECONNREFUSED');
    }
  });

  it('fail si metadata incompleta (sin token_endpoint)', async () => {
    const { svc } = setupService();
    svc.issuerStub = {
      metadata: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        // token_endpoint: missing
      },
    };
    const result = await svc.testDiscovery(ISSUER);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startFlow
// ---------------------------------------------------------------------------

describe('OidcService.startFlow', () => {
  it('rechaza tenant inexistente', async () => {
    const { svc } = setupService();
    await expect(svc.startFlow('does-not-exist')).rejects.toThrow(NotFoundException);
  });

  it('rechaza tenant sin config OIDC', async () => {
    const { svc, tenantSlug } = setupService({ config: null });
    await expect(svc.startFlow(tenantSlug)).rejects.toThrow(NotFoundException);
  });

  it('rechaza tenant con config disabled', async () => {
    const { svc, tenantSlug } = setupService({ config: { enabled: false } });
    await expect(svc.startFlow(tenantSlug)).rejects.toThrow(NotFoundException);
  });

  it('rechaza si discovery falla con ServiceUnavailableException', async () => {
    const { svc, tenantSlug } = setupService();
    svc.discoveryFails = new Error('boom');
    await expect(svc.startFlow(tenantSlug)).rejects.toThrow(ServiceUnavailableException);
  });

  it('genera state+nonce+codeVerifier únicos en cada call', async () => {
    const { svc, tenantSlug } = setupService();
    const flow1 = await svc.startFlow(tenantSlug);
    const flow2 = await svc.startFlow(tenantSlug);
    expect(flow1.state).not.toBe(flow2.state);
    expect(flow1.nonce).not.toBe(flow2.nonce);
    expect(flow1.codeVerifier).not.toBe(flow2.codeVerifier);
    expect(flow1.state.length).toBeGreaterThanOrEqual(40);
    expect(flow1.nonce.length).toBeGreaterThanOrEqual(40);
    expect(svc.__activeFlowsForTest).toBe(2);
  });

  it('construye authorizationUrl con scopes joined y delega al client', async () => {
    const { svc, tenantSlug } = setupService({
      config: { scopes: ['openid', 'email', 'profile', 'groups'] },
    });
    const flow = await svc.startFlow(tenantSlug);
    expect(svc.buildSpy).toHaveBeenCalledOnce();
    const args = svc.buildSpy.mock.calls[0]!;
    expect(args[1].scope).toBe('openid email profile groups');
    expect(args[1].state).toBe(flow.state);
    expect(args[1].nonce).toBe(flow.nonce);
    expect(args[1].codeChallenge.length).toBeGreaterThan(40); // sha256 b64url
  });
});

// ---------------------------------------------------------------------------
// handleCallback
// ---------------------------------------------------------------------------

describe('OidcService.handleCallback', () => {
  it('rechaza si el IdP devolvió error', async () => {
    const { svc } = setupService();
    await expect(
      svc.handleCallback({ error: 'access_denied', errorDescription: 'user said no' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza si falta state', async () => {
    const { svc } = setupService();
    await expect(svc.handleCallback({ code: 'abc' })).rejects.toThrow(BadRequestException);
  });

  it('rechaza state desconocido (no en flowStore)', async () => {
    const { svc } = setupService();
    await expect(svc.handleCallback({ state: 'unknown', code: 'abc' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza state expirado', async () => {
    const { svc, tenantSlug } = setupService();
    const flow = await svc.startFlow(tenantSlug);
    // Manualmente expiramos el flow tocando el insertor de tests:
    svc.__resetCachesForTest();
    svc.__insertFlowForTest(flow.state, {
      tenantId: 'tenant-1',
      tenantSlug,
      nonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expiresAt: Date.now() - 1, // ya vencido
      startedAt: '2026-04-30T09:00:00.000Z',
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza nonce mismatch (id_token nonce != flow.nonce)', async () => {
    const { svc, tenantSlug } = setupService();
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-1',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: 'wrong-nonce',
        email: 'user@acme.com',
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /nonce/i,
    );
  });

  it('rechaza aud mismatch', async () => {
    const { svc, tenantSlug } = setupService();
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-1',
        iss: ISSUER,
        aud: 'OTHER-CLIENT',
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'user@acme.com',
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /aud/i,
    );
  });

  it('rechaza iss mismatch', async () => {
    const { svc, tenantSlug } = setupService();
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-1',
        iss: 'https://attacker.example.com',
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'user@acme.com',
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /iss/i,
    );
  });

  it('rechaza si email no está en allowedEmailDomains', async () => {
    const { svc, tenantSlug } = setupService({
      config: { allowedEmailDomains: ['acme.com'], autoProvisionUsers: true },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-1',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'user@gmail.com',
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /dominios permitidos/,
    );
  });

  it('rechaza si autoProvision=false y user no existe', async () => {
    const { svc, tenantSlug } = setupService({
      config: { autoProvisionUsers: false },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-1',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'newuser@acme.com',
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /No tenés cuenta/,
    );
  });

  it('autoProvision=true crea user con status=ACTIVE y emite tokens', async () => {
    const { svc, prisma, tokens, al, tenantSlug } = setupService({
      config: { autoProvisionUsers: true },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-1',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'NEWUSER@acme.com',
        name: 'Juana Pérez',
      },
    });
    const result = await svc.handleCallback({ state: flow.state, code: 'abc' });
    expect(result.tokens.accessToken).toBe('access-token-fake');
    expect(result.user.email).toBe('newuser@acme.com'); // lowercased
    expect(prisma._users).toHaveLength(1);
    expect(prisma._users[0]!.status).toBe('ACTIVE');
    expect(prisma._users[0]!.passwordHash).toBeNull();
    expect(prisma._users[0]!.name).toBe('Juana Pérez');
    expect(tokens.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        tenantId: 'tenant-1',
        mfaVerified: true,
      }),
    );
    expect(al._entries.some((e) => e['action'] === 'sso.oidc.user.provisioned')).toBe(true);
    expect(al._entries.some((e) => e['action'] === 'sso.oidc.signin.success')).toBe(true);
  });

  it('user existente ACTIVE: no crea, refresca lastLogin y emite tokens', async () => {
    const { svc, prisma, tokens, tenantSlug } = setupService({
      existingUser: { email: 'existing@acme.com', status: 'ACTIVE', roles: ['student', 'tenant_admin'] },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-existing',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'existing@acme.com',
      },
    });
    const result = await svc.handleCallback({ state: flow.state, code: 'abc' });
    expect(prisma._users).toHaveLength(1); // sin crear nuevo
    expect(prisma.user.update).toHaveBeenCalled();
    expect(result.user.roles).toEqual(['student', 'tenant_admin']);
    expect(tokens.sign).toHaveBeenCalledWith(
      expect.objectContaining({ mfaVerified: true }),
    );
  });

  it('user existente DEACTIVATED → 401 (no permitimos rehab via SSO)', async () => {
    const { svc, tenantSlug } = setupService({
      existingUser: { email: 'inactive@acme.com', status: 'DEACTIVATED' },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-2',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'inactive@acme.com',
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /no está activa/,
    );
  });

  it('state se consume una sola vez (defensa replay)', async () => {
    const { svc, tenantSlug } = setupService({
      existingUser: { email: 'u@acme.com' },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 's1',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'u@acme.com',
      },
    });
    await svc.handleCallback({ state: flow.state, code: 'abc' });
    // Segundo callback con el mismo state → state desconocido (ya consumido).
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /State desconocido/,
    );
  });

  it('config aud=array con clientId incluido → aceptado', async () => {
    const { svc, tenantSlug } = setupService({
      existingUser: { email: 'u@acme.com' },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 's1',
        iss: ISSUER,
        aud: ['other-aud', CLIENT_ID, 'extra'],
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'u@acme.com',
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).resolves.toBeTruthy();
  });

  it('rechaza email inválido (sin email en id_token)', async () => {
    const { svc, tenantSlug } = setupService({
      config: { autoProvisionUsers: true },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user-1',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        // email: missing!
        // preferred_username: missing!
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /email válido/,
    );
  });

  it('si config se desactiva durante el flow → reject', async () => {
    const { svc, tc, tenantSlug, tenantId } = setupService({
      existingUser: { email: 'u@acme.com' },
    });
    const flow = await svc.startFlow(tenantSlug);
    // Admin desactiva config:
    const cfg = (await tc.get(tenantId, OIDC_CONFIG_MODULE_NAME, OIDC_CONFIG_KEY)) as TenantOidcConfig;
    await tc.set(tenantId, OIDC_CONFIG_MODULE_NAME, OIDC_CONFIG_KEY, { ...cfg, enabled: false }, {
      isSecret: true,
    });
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 's1',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'u@acme.com',
      },
    });
    await expect(svc.handleCallback({ state: flow.state, code: 'abc' })).rejects.toThrow(
      /deshabilitada/,
    );
  });

  it('compone displayName desde given_name + family_name si name no viene', async () => {
    const { svc, prisma, tenantSlug } = setupService({
      config: { autoProvisionUsers: true },
    });
    const flow = await svc.startFlow(tenantSlug);
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'sub1',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'composed@acme.com',
        given_name: 'Mario',
        family_name: 'Bros',
      },
    });
    await svc.handleCallback({ state: flow.state, code: 'abc' });
    expect(prisma._users[0]!.name).toBe('Mario Bros');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('OidcService — tenant isolation', () => {
  it('flow del tenant A no autentica al user de tenant B', async () => {
    const prisma = makeFakePrisma();
    const tc = makeFakeTenantConfig();
    const al = makeFakeAuditLog();
    const tokens = makeFakeTokens();

    prisma._tenants.push(
      { id: 'tenant-A', slug: 'a', name: 'A', status: 'ACTIVE' },
      { id: 'tenant-B', slug: 'b', name: 'B', status: 'ACTIVE' },
    );
    // Mismo email en ambos tenants — los rows son distintos:
    prisma._users.push(
      {
        id: 'user-a',
        tenantId: 'tenant-A',
        email: 'shared@example.com',
        name: 'A user',
        status: 'ACTIVE',
        passwordHash: null,
        lastLoginAt: null,
        roles: [{ role: { name: 'student' } }],
        tenant: prisma._tenants[0]!,
      },
      {
        id: 'user-b',
        tenantId: 'tenant-B',
        email: 'shared@example.com',
        name: 'B user',
        status: 'ACTIVE',
        passwordHash: null,
        lastLoginAt: null,
        roles: [{ role: { name: 'tenant_admin' } }],
        tenant: prisma._tenants[1]!,
      },
    );
    const cfgA = fixtureConfig();
    tc._records.set(`tenant-A::${OIDC_CONFIG_MODULE_NAME}::${OIDC_CONFIG_KEY}`, {
      value: cfgA,
      isSecret: true,
    });

    const svc = new TestOidcService(
      prisma as unknown as ConstructorParameters<typeof OidcService>[0],
      tc as unknown as ConstructorParameters<typeof OidcService>[1],
      al as unknown as ConstructorParameters<typeof OidcService>[2],
      tokens as unknown as ConstructorParameters<typeof OidcService>[3],
    );
    svc.issuerStub = {
      metadata: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      },
    };
    svc.clientStub = {
      authorizationUrl: () => `${ISSUER}/authorize`,
      callback: vi.fn(),
    };

    const flow = await svc.startFlow('a'); // flow guarda tenantId='tenant-A'
    svc.exchangeStub = async () => ({
      idTokenClaims: {
        sub: 'idp-user',
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: flow.nonce,
        email: 'shared@example.com',
      },
    });
    const result = await svc.handleCallback({ state: flow.state, code: 'abc' });
    // Debe haber resuelto al user de tenant A, no al de tenant B.
    expect(result.user.id).toBe('user-a');
    expect(result.user.tenantId).toBe('tenant-A');
  });
});
