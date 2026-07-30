import { sessionRegistryStub } from './helpers/session-registry-stub';
/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del SamlService — 9º piloto License SDK (`feat:sso.saml`).
 *
 * Cobertura mínima:
 *   - getConfig devuelve null si no hay config / corrupta.
 *   - setConfig persiste con isSecret:false (cert IdP es público) y updatedAt
 *     se refresca preservando createdAt.
 *   - deleteConfig idempotente.
 *   - testConnection rechaza cert no-PEM, acepta cert válido.
 *   - startFlow rechaza tenant inexistente / sin config / disabled.
 *   - startFlow genera relayState + requestId únicos.
 *   - handleAcs rechaza relayState desconocido / expirado.
 *   - handleAcs rechaza issuer mismatch.
 *   - handleAcs rechaza email no en allowedEmailDomains.
 *   - handleAcs con autoProvision=false y user no existe → reject.
 *   - handleAcs con autoProvision=true crea user.
 *   - handleAcs consume relayState una sola vez (defensa replay).
 *   - handleAcs rechaza user inactivo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SamlService } from '../src/sso/saml/saml.service';
import {
  SAML_CONFIG_KEY,
  SAML_CONFIG_MODULE_NAME,
  type ParsedSamlAssertion,
  type TenantSamlConfig,
} from '../src/sso/saml/saml.types';

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

function makeFakePrisma() {
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
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
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

function makeFakeTenantConfig() {
  const records = new Map<string, { value: unknown; isSecret: boolean }>();
  const key = (tenantId: string, m: string, k: string) => `${tenantId}::${m}::${k}`;
  return {
    _records: records,
    set: vi.fn(
      async (
        tenantId: string,
        m: string,
        k: string,
        value: unknown,
        opts?: { isSecret?: boolean },
      ) => {
        records.set(key(tenantId, m, k), { value, isSecret: opts?.isSecret ?? false });
      },
    ),
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
// Stub-able SamlService — sobreescribe wrappers de @node-saml/node-saml.
// ---------------------------------------------------------------------------

class TestSamlService extends SamlService {
  public providerStub: {
    getAuthorizeUrlAsync: ReturnType<typeof vi.fn>;
    validatePostResponseAsync: ReturnType<typeof vi.fn>;
    generateServiceProviderMetadata: ReturnType<typeof vi.fn>;
  } = {
    getAuthorizeUrlAsync: vi.fn(
      async (relayState: string) =>
        `https://idp.example.com/sso?SAMLRequest=fake&RelayState=${relayState}`,
    ),
    validatePostResponseAsync: vi.fn(),
    generateServiceProviderMetadata: vi.fn(() => '<EntityDescriptor>fake</EntityDescriptor>'),
  };

  public parsedStub: ParsedSamlAssertion | null = null;
  public parseFails: Error | null = null;

  protected buildProvider(): {
    getAuthorizeUrlAsync: ReturnType<typeof vi.fn>;
    validatePostResponseAsync: ReturnType<typeof vi.fn>;
    generateServiceProviderMetadata: ReturnType<typeof vi.fn>;
  } {
    // El cast es seguro: el shape del stub es el mismo que SamlProviderLike
    // (los signatures matchean). vitest fn() permite stub flexible.
    return this.providerStub;
  }

  protected async validateAndParse(): Promise<ParsedSamlAssertion> {
    if (this.parseFails) throw this.parseFails;
    if (!this.parsedStub) throw new Error('parsedStub no configurado.');
    return this.parsedStub;
  }

  protected inspectCertificate(pem: string): {
    subject?: string;
    notAfter?: string;
    signatureAlgorithm?: string;
  } {
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('El certificado no es PEM válido o está corrupto.');
    }
    return { subject: 'CN=test', notAfter: '2099-01-01T00:00:00.000Z' };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDP_ENTITY_ID = 'urn:idp:example';
const IDP_SSO_URL = 'https://idp.example.com/sso';
const IDP_CERT = '-----BEGIN CERTIFICATE-----\nMIIDfake==\n-----END CERTIFICATE-----\n';

function fixtureConfig(overrides: Partial<TenantSamlConfig> = {}): TenantSamlConfig {
  const now = '2026-05-01T10:00:00.000Z';
  return {
    enabled: true,
    idpEntityId: IDP_ENTITY_ID,
    idpSsoUrl: IDP_SSO_URL,
    idpCertificate: IDP_CERT,
    attributeMapping: {
      email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
      lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    },
    allowedEmailDomains: [],
    autoProvisionUsers: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setupService(opts?: {
  tenantId?: string;
  tenantSlug?: string;
  config?: Partial<TenantSamlConfig> | null;
  existingUser?: { email: string; status?: FakeUserRow['status']; roles?: string[] };
}) {
  const tenantId = opts?.tenantId ?? 'tenant-1';
  const tenantSlug = opts?.tenantSlug ?? 'acme';
  const prisma = makeFakePrisma();
  const tc = makeFakeTenantConfig();
  const al = makeFakeAuditLog();
  const tokens = makeFakeTokens();

  prisma._tenants.push({
    id: tenantId,
    slug: tenantSlug,
    name: 'Acme',
    status: 'ACTIVE',
  });

  // opts.config === null → no insertar (caso "sin config").
  // opts.config undefined o un objeto → insertar con overrides aplicados.
  if (opts?.config !== null) {
    const cfg = fixtureConfig(opts?.config ?? {});
    tc._records.set(`${tenantId}::${SAML_CONFIG_MODULE_NAME}::${SAML_CONFIG_KEY}`, {
      value: cfg,
      isSecret: false,
    });
  }

  if (opts?.existingUser) {
    prisma._users.push({
      id: 'user-existing',
      tenantId,
      email: opts.existingUser.email,
      name: 'Existing User',
      status: opts.existingUser.status ?? 'ACTIVE',
      passwordHash: 'argon2-hash',
      lastLoginAt: null,
      roles: (opts.existingUser.roles ?? ['student']).map((r) => ({ role: { name: r } })),
      tenant: prisma._tenants[0]!,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new TestSamlService(
    prisma as any,
    tc as any,
    al as any,
    tokens as any,
    sessionRegistryStub(tokens as never),
  );
  return { service, prisma, tc, al, tokens, tenantId, tenantSlug };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SamlService', () => {
  beforeEach(() => {
    process.env['SAML_PUBLIC_API_URL'] = 'http://localhost:4000';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getConfig', () => {
    it('devuelve null si no hay config', async () => {
      const { service, tenantId } = setupService({ config: null });
      expect(await service.getConfig(tenantId)).toBeNull();
    });

    it('devuelve null si la config está corrupta (sin idpEntityId)', async () => {
      const { service, tc, tenantId } = setupService({ config: null });
      tc._records.set(`${tenantId}::sso::saml.config`, {
        value: { enabled: true, idpSsoUrl: IDP_SSO_URL },
        isSecret: false,
      });
      expect(await service.getConfig(tenantId)).toBeNull();
    });

    it('devuelve la config si está completa', async () => {
      const { service, tenantId } = setupService();
      const cfg = await service.getConfig(tenantId);
      expect(cfg).not.toBeNull();
      expect(cfg!.idpEntityId).toBe(IDP_ENTITY_ID);
    });
  });

  describe('setConfig', () => {
    it('persiste con isSecret:false (cert IdP es público)', async () => {
      const { service, tc, tenantId, tenantSlug } = setupService({ config: null });
      await service.setConfig(
        tenantId,
        tenantSlug,
        {
          enabled: true,
          idpEntityId: IDP_ENTITY_ID,
          idpSsoUrl: IDP_SSO_URL,
          idpCertificate: IDP_CERT,
          attributeMapping: { email: 'email' },
          allowedEmailDomains: [],
          autoProvisionUsers: false,
        },
        'admin-1',
      );
      expect(tc.set).toHaveBeenCalledWith(
        tenantId,
        SAML_CONFIG_MODULE_NAME,
        SAML_CONFIG_KEY,
        expect.objectContaining({ idpEntityId: IDP_ENTITY_ID }),
        expect.objectContaining({ isSecret: false, actorId: 'admin-1' }),
      );
    });

    it('preserva createdAt y refresca updatedAt en update', async () => {
      const { service, tenantId, tenantSlug } = setupService();
      const before = await service.getConfig(tenantId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const safe = await service.setConfig(
        tenantId,
        tenantSlug,
        {
          enabled: false,
          idpEntityId: IDP_ENTITY_ID,
          idpSsoUrl: IDP_SSO_URL,
          idpCertificate: IDP_CERT,
          attributeMapping: { email: 'email' },
          allowedEmailDomains: [],
          autoProvisionUsers: true,
        },
        'admin-1',
      );
      expect(safe.createdAt).toBe(before!.createdAt);
      expect(new Date(safe.updatedAt).getTime()).toBeGreaterThan(
        new Date(before!.updatedAt).getTime(),
      );
    });

    it('emite SP URLs computed con el tenantSlug', async () => {
      const { service, tenantId, tenantSlug } = setupService({ config: null });
      const safe = await service.setConfig(
        tenantId,
        tenantSlug,
        {
          enabled: true,
          idpEntityId: IDP_ENTITY_ID,
          idpSsoUrl: IDP_SSO_URL,
          idpCertificate: IDP_CERT,
          attributeMapping: { email: 'email' },
          allowedEmailDomains: [],
          autoProvisionUsers: false,
        },
        'admin-1',
      );
      expect(safe.spAcsUrl).toContain(`/auth/saml/${tenantSlug}/acs`);
      expect(safe.spMetadataUrl).toContain(`/auth/saml/${tenantSlug}/metadata`);
    });
  });

  describe('deleteConfig', () => {
    it('idempotente: segundo delete devuelve { deleted: false }', async () => {
      const { service, tenantId } = setupService();
      const r1 = await service.deleteConfig(tenantId, 'admin-1');
      const r2 = await service.deleteConfig(tenantId, 'admin-1');
      expect(r1.deleted).toBe(true);
      expect(r2.deleted).toBe(false);
    });
  });

  describe('testConnection', () => {
    it('rechaza cert no-PEM', async () => {
      const { service } = setupService({ config: null });
      const probe = await service.testConnection('not a cert', IDP_SSO_URL);
      expect(probe.ok).toBe(false);
    });

    it('acepta cert PEM bien formado', async () => {
      const { service } = setupService({ config: null });
      const probe = await service.testConnection(IDP_CERT, IDP_SSO_URL);
      expect(probe.ok).toBe(true);
    });
  });

  describe('startFlow', () => {
    it('rechaza tenant inexistente', async () => {
      const { service } = setupService();
      await expect(service.startFlow('does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza tenant sin config', async () => {
      const { service, tenantSlug } = setupService({ config: null });
      await expect(service.startFlow(tenantSlug)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza tenant con config disabled', async () => {
      const { service, tenantSlug } = setupService({ config: { enabled: false } });
      await expect(service.startFlow(tenantSlug)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('genera relayState y requestId únicos en flows distintos', async () => {
      const { service, tenantSlug } = setupService();
      const f1 = await service.startFlow(tenantSlug);
      const f2 = await service.startFlow(tenantSlug);
      expect(f1.relayState).not.toBe(f2.relayState);
      expect(f1.requestId).not.toBe(f2.requestId);
      expect(service.__activeFlowsForTest).toBe(2);
    });
  });

  describe('handleAcs', () => {
    it('rechaza relayState desconocido', async () => {
      const { service } = setupService();
      await expect(
        service.handleAcs({ samlResponse: 'fake', relayState: 'unknown-state' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('consume el relayState una sola vez (defensa replay)', async () => {
      const { service, tenantId, tenantSlug } = setupService({
        config: { autoProvisionUsers: true },
      });
      const start = await service.startFlow(tenantSlug);
      (service as TestSamlService).parsedStub = {
        nameId: 'user@acme.com',
        issuer: IDP_ENTITY_ID,
        responseId: 'r1',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'user@acme.com',
        },
      };
      void tenantId;
      await service.handleAcs({ samlResponse: 'fake', relayState: start.relayState });
      // Segundo intento con el mismo relayState → rejected.
      await expect(
        service.handleAcs({ samlResponse: 'fake', relayState: start.relayState }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rechaza issuer mismatch', async () => {
      const { service, tenantSlug } = setupService();
      const start = await service.startFlow(tenantSlug);
      (service as TestSamlService).parsedStub = {
        nameId: 'user@acme.com',
        issuer: 'urn:other-idp',
        responseId: 'r1',
        attributes: {},
      };
      await expect(
        service.handleAcs({ samlResponse: 'fake', relayState: start.relayState }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rechaza email fuera de allowedEmailDomains', async () => {
      const { service, tenantSlug } = setupService({
        config: { allowedEmailDomains: ['acme.com'], autoProvisionUsers: true },
      });
      const start = await service.startFlow(tenantSlug);
      (service as TestSamlService).parsedStub = {
        nameId: 'user@enemy.com',
        issuer: IDP_ENTITY_ID,
        responseId: 'r1',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'user@enemy.com',
        },
      };
      await expect(
        service.handleAcs({ samlResponse: 'fake', relayState: start.relayState }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rechaza user no provisionado cuando autoProvision=false', async () => {
      const { service, tenantSlug } = setupService({ config: { autoProvisionUsers: false } });
      const start = await service.startFlow(tenantSlug);
      (service as TestSamlService).parsedStub = {
        nameId: 'newuser@acme.com',
        issuer: IDP_ENTITY_ID,
        responseId: 'r1',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'newuser@acme.com',
        },
      };
      await expect(
        service.handleAcs({ samlResponse: 'fake', relayState: start.relayState }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('crea user con autoProvision=true cuando no existe', async () => {
      const { service, prisma, tenantSlug } = setupService({
        config: { autoProvisionUsers: true },
      });
      const start = await service.startFlow(tenantSlug);
      (service as TestSamlService).parsedStub = {
        nameId: 'newuser@acme.com',
        issuer: IDP_ENTITY_ID,
        responseId: 'r1',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'newuser@acme.com',
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'New',
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname': 'User',
        },
      };
      const result = await service.handleAcs({
        samlResponse: 'fake',
        relayState: start.relayState,
      });
      expect(result.user.email).toBe('newuser@acme.com');
      expect(result.user.name).toBe('New User');
      expect(prisma.user.create).toHaveBeenCalledOnce();
    });

    it('rechaza user inactivo', async () => {
      const { service, tenantSlug } = setupService({
        config: { autoProvisionUsers: false },
        existingUser: { email: 'inactive@acme.com', status: 'SUSPENDED' },
      });
      const start = await service.startFlow(tenantSlug);
      (service as TestSamlService).parsedStub = {
        nameId: 'inactive@acme.com',
        issuer: IDP_ENTITY_ID,
        responseId: 'r1',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'inactive@acme.com',
        },
      };
      await expect(
        service.handleAcs({ samlResponse: 'fake', relayState: start.relayState }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('login OK para user existente activo', async () => {
      const { service, tenantSlug, tokens } = setupService({
        config: { autoProvisionUsers: false },
        existingUser: { email: 'existing@acme.com', status: 'ACTIVE' },
      });
      const start = await service.startFlow(tenantSlug);
      (service as TestSamlService).parsedStub = {
        nameId: 'existing@acme.com',
        issuer: IDP_ENTITY_ID,
        responseId: 'r1',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'existing@acme.com',
        },
      };
      const result = await service.handleAcs({
        samlResponse: 'fake',
        relayState: start.relayState,
      });
      expect(result.user.email).toBe('existing@acme.com');
      expect(tokens.sign).toHaveBeenCalledWith(
        expect.objectContaining({ mfaVerified: true, roles: ['student'] }),
      );
    });

    it('rechaza si SAMLResponse no parsea (firma inválida, etc.)', async () => {
      const { service, tenantSlug } = setupService();
      const start = await service.startFlow(tenantSlug);
      (service as TestSamlService).parseFails = new Error('Invalid signature');
      await expect(
        service.handleAcs({ samlResponse: 'fake', relayState: start.relayState }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('isEnabledForTenantSlug', () => {
    it('true cuando hay config con enabled=true', async () => {
      const { service, tenantSlug } = setupService();
      expect(await service.isEnabledForTenantSlug(tenantSlug)).toBe(true);
    });

    it('false cuando enabled=false', async () => {
      const { service, tenantSlug } = setupService({ config: { enabled: false } });
      expect(await service.isEnabledForTenantSlug(tenantSlug)).toBe(false);
    });

    it('false cuando no hay tenant', async () => {
      const { service } = setupService();
      expect(await service.isEnabledForTenantSlug('does-not-exist')).toBe(false);
    });
  });
});
