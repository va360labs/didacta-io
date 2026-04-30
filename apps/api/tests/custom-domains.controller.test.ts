/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del CustomDomainsController — cuarto piloto License SDK.
 *
 * Cobertura mínima exigida (LMS-XXX, gate `feat:custom_domains`):
 *  - Sin licencia: cada endpoint devuelve CapabilityRequiredError (mapea a 402
 *    vía LicenseExceptionFilter — esto se valida con
 *    `license.requireCapability(...)` que es lo que ejecuta el guard).
 *  - Con dev bypass: CRUD completo funciona end-to-end.
 *  - Filtro tenant: tenants distintos no comparten dominios.
 *  - Validación hostname (Zod): rechaza protocolos, mayúsculas, sin TLD, etc.
 *  - Verify con token correcto → verified; con token incorrecto → 409.
 *  - DELETE de dominio inexistente → 404.
 *  - Audit log entries para cada acción.
 *  - Acceso restringido a super_admin / tenant_admin.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LicenseService,
  LICENSE_CAPABILITIES,
  CapabilityRequiredError,
} from '@didacta/license-sdk';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CustomDomainsController } from '../src/admin/custom-domains/custom-domains.controller';
import { CustomDomainsService } from '../src/admin/custom-domains/custom-domains.service';
import {
  addCustomDomainDtoSchema,
  setCustomDomainStatusDtoSchema,
  verifyCustomDomainDtoSchema,
} from '../src/admin/custom-domains/custom-domains.dto';
import type { SessionClaims } from '../src/auth/token.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeTenantConfig = ConstructorParameters<typeof CustomDomainsService>[0];
type FakeAuditLog = ConstructorParameters<typeof CustomDomainsController>[1];

function makeTenantConfig(): FakeTenantConfig {
  const store = new Map<string, unknown>();
  const k = (t: string, m: string, key: string) => `${t}::${m}::${key}`;
  return {
    get: vi.fn(async (t: string, m: string, key: string) => store.get(k(t, m, key))),
    set: vi.fn(async (t: string, m: string, key: string, value: unknown) => {
      store.set(k(t, m, key), value);
    }),
  } as unknown as FakeTenantConfig;
}

function makeAuditLog(): {
  audit: FakeAuditLog;
  recordSpy: ReturnType<typeof vi.fn>;
} {
  const recordSpy = vi.fn().mockResolvedValue(undefined);
  return {
    audit: { record: recordSpy } as unknown as FakeAuditLog,
    recordSpy,
  };
}

const FAKE_REQ = { headers: {}, ip: '127.0.0.1' } as unknown as Parameters<
  CustomDomainsController['add']
>[0];

const adminUser: SessionClaims = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  roles: ['tenant_admin'],
  mfaVerified: true,
};

const studentUser: SessionClaims = {
  sub: 'user-2',
  tenantId: 'tenant-1',
  roles: ['alumno'],
  mfaVerified: false,
};

const otherTenantAdmin: SessionClaims = {
  sub: 'user-3',
  tenantId: 'tenant-2',
  roles: ['tenant_admin'],
  mfaVerified: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomDomainsController · gate feat:custom_domains', () => {
  let license: LicenseService;
  let tenantConfig: FakeTenantConfig;
  let service: CustomDomainsService;
  let auditLog: FakeAuditLog;
  let recordSpy: ReturnType<typeof vi.fn>;
  let controller: CustomDomainsController;

  beforeEach(() => {
    license = new LicenseService();
    tenantConfig = makeTenantConfig();
    service = new CustomDomainsService(tenantConfig);
    const a = makeAuditLog();
    auditLog = a.audit;
    recordSpy = a.recordSpy;
    controller = new CustomDomainsController(service, auditLog);
  });

  // -------------------------------------------------------------------------
  // 1. Sin licencia → cada endpoint pasa por el guard, que llama
  //    license.requireCapability() y lanza CapabilityRequiredError.
  // -------------------------------------------------------------------------
  describe('community (sin licencia EE)', () => {
    beforeEach(async () => {
      await license.load({ key: null });
    });

    it('requireCapability(CUSTOM_DOMAINS) lanza CapabilityRequiredError', () => {
      expect(() => license.requireCapability(LICENSE_CAPABILITIES.CUSTOM_DOMAINS)).toThrow(
        CapabilityRequiredError,
      );
    });

    it('el error tipado lleva la capability requerida (mapea a 402 en filter)', () => {
      try {
        license.requireCapability(LICENSE_CAPABILITIES.CUSTOM_DOMAINS);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CapabilityRequiredError);
        expect((e as CapabilityRequiredError).capability).toBe(LICENSE_CAPABILITIES.CUSTOM_DOMAINS);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Con dev bypass: CRUD completo + audit log.
  // -------------------------------------------------------------------------
  describe('con dev bypass (capability activa)', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('GET / devuelve lista vacía inicial', async () => {
      const res = await controller.list(adminUser);
      expect(res.domains).toEqual([]);
      expect(res.capability).toBe(LICENSE_CAPABILITIES.CUSTOM_DOMAINS);
    });

    it('POST / añade dominio en pending y registra audit', async () => {
      const created = await controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' });
      expect(created.hostname).toBe('acme.com');
      expect(created.status).toBe('pending');
      expect(created.verificationToken.length).toBeGreaterThan(0);
      expect(created.cnameTarget.length).toBeGreaterThan(0);

      expect(recordSpy).toHaveBeenCalledTimes(1);
      const entry = recordSpy.mock.calls[0]![0];
      expect(entry.action).toBe('tenancy.custom_domain.added');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.actorId).toBe('user-1');
      expect(entry.resourceType).toBe('custom_domain');
      expect(entry.resourceId).toBe(created.id);
      expect(entry.metadata).toMatchObject({
        hostname: 'acme.com',
        cnameTarget: created.cnameTarget,
      });
    });

    it('POST / dos dominios → GET / lista los dos', async () => {
      await controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' });
      await controller.add(FAKE_REQ, adminUser, { hostname: 'learn.acme.com' });
      const res = await controller.list(adminUser);
      expect(res.domains).toHaveLength(2);
    });

    it('POST / duplicado → ConflictException', async () => {
      await controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' });
      await expect(controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('POST /:id/verify con token correcto → verified + audit', async () => {
      const created = await controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' });
      const verified = await controller.verify(FAKE_REQ, adminUser, created.id, {
        providedToken: created.verificationToken,
      });
      expect(verified.status).toBe('verified');
      expect(verified.verifiedAt).not.toBeNull();

      // segundo registro audit (added + verified).
      expect(recordSpy).toHaveBeenCalledTimes(2);
      const entry = recordSpy.mock.calls[1]![0];
      expect(entry.action).toBe('tenancy.custom_domain.verified');
      expect(entry.metadata.hostname).toBe('acme.com');
    });

    it('POST /:id/verify con token incorrecto → ConflictException', async () => {
      const created = await controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' });
      await expect(
        controller.verify(FAKE_REQ, adminUser, created.id, {
          providedToken: 'token-incorrecto',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('POST /:id/verify sobre id inexistente → NotFoundException', async () => {
      await expect(
        controller.verify(FAKE_REQ, adminUser, '00000000-0000-0000-0000-000000000000', {
          providedToken: 'cualquiera',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('PATCH /:id cambia status verified ↔ inactive + audit', async () => {
      const created = await controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' });
      await controller.verify(FAKE_REQ, adminUser, created.id, {
        providedToken: created.verificationToken,
      });
      const off = await controller.patch(FAKE_REQ, adminUser, created.id, {
        status: 'inactive',
      });
      expect(off.status).toBe('inactive');
      const on = await controller.patch(FAKE_REQ, adminUser, created.id, {
        status: 'verified',
      });
      expect(on.status).toBe('verified');

      // audit calls: added + verified + 2x status_changed
      const actions = recordSpy.mock.calls.map((c) => (c[0] as { action: string }).action);
      expect(actions).toEqual([
        'tenancy.custom_domain.added',
        'tenancy.custom_domain.verified',
        'tenancy.custom_domain.status_changed',
        'tenancy.custom_domain.status_changed',
      ]);
    });

    it('DELETE /:id borra el dominio + audit', async () => {
      const created = await controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' });
      const res = await controller.remove(FAKE_REQ, adminUser, created.id);
      expect(res).toEqual({ id: created.id, removed: true });

      const after = await controller.list(adminUser);
      expect(after.domains).toEqual([]);

      const last = recordSpy.mock.calls[recordSpy.mock.calls.length - 1]![0];
      expect(last.action).toBe('tenancy.custom_domain.removed');
      expect(last.metadata.hostname).toBe('acme.com');
    });

    it('DELETE /:id sobre id inexistente → NotFoundException', async () => {
      await expect(
        controller.remove(FAKE_REQ, adminUser, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundException);
    });

    // -----------------------------------------------------------------------
    // Filtro tenant (no-leak)
    // -----------------------------------------------------------------------
    it('tenants distintos no se ven dominios entre sí', async () => {
      await controller.add(FAKE_REQ, adminUser, { hostname: 'acme.com' });
      await controller.add(FAKE_REQ, otherTenantAdmin, { hostname: 'beta.example.com' });

      const list1 = await controller.list(adminUser);
      const list2 = await controller.list(otherTenantAdmin);

      expect(list1.domains).toHaveLength(1);
      expect(list2.domains).toHaveLength(1);
      expect(list1.domains[0]!.hostname).toBe('acme.com');
      expect(list2.domains[0]!.hostname).toBe('beta.example.com');
    });

    // -----------------------------------------------------------------------
    // Autorización
    // -----------------------------------------------------------------------
    it('GET sin user → UnauthorizedException', async () => {
      await expect(controller.list(undefined)).rejects.toThrow(UnauthorizedException);
    });

    it('POST con rol alumno → ForbiddenException', async () => {
      await expect(controller.add(FAKE_REQ, studentUser, { hostname: 'acme.com' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('POST con rol super_admin → permitido', async () => {
      const superAdmin: SessionClaims = { ...adminUser, roles: ['super_admin'] };
      const created = await controller.add(FAKE_REQ, superAdmin, { hostname: 'acme.com' });
      expect(created.hostname).toBe('acme.com');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Validación Zod del DTO de hostname.
// ---------------------------------------------------------------------------
describe('CustomDomainsController · validación de DTO (Zod)', () => {
  describe('addCustomDomainDtoSchema', () => {
    it('acepta dominios válidos sencillos', () => {
      for (const h of [
        'acme.com',
        'learn.acme.com',
        'a.b.c.example.io',
        'edu-1.test.com',
        'foo.bar.baz.qux.example.org',
      ]) {
        const r = addCustomDomainDtoSchema.safeParse({ hostname: h });
        expect(r.success).toBe(true);
      }
    });

    it('rechaza protocolos http(s)://', () => {
      for (const h of ['https://acme.com', 'http://acme.com']) {
        const r = addCustomDomainDtoSchema.safeParse({ hostname: h });
        expect(r.success).toBe(false);
      }
    });

    it('rechaza mayúsculas (admin debe normalizar antes)', () => {
      const r = addCustomDomainDtoSchema.safeParse({ hostname: 'ACME.com' });
      expect(r.success).toBe(false);
    });

    it('rechaza hostnames sin TLD (incluido `localhost`)', () => {
      for (const h of ['localhost', 'intranet', 'box']) {
        const r = addCustomDomainDtoSchema.safeParse({ hostname: h });
        expect(r.success).toBe(false);
      }
    });

    it('rechaza path/query/puerto', () => {
      for (const h of ['acme.com/path', 'acme.com:8080', 'acme.com?x=1']) {
        const r = addCustomDomainDtoSchema.safeParse({ hostname: h });
        expect(r.success).toBe(false);
      }
    });

    it('rechaza labels que empiezan o terminan con guión', () => {
      for (const h of ['-acme.com', 'acme.com-', 'foo.-bar.com', 'foo.bar-.com']) {
        const r = addCustomDomainDtoSchema.safeParse({ hostname: h });
        expect(r.success).toBe(false);
      }
    });

    it('rechaza chars no permitidos (espacios, símbolos)', () => {
      for (const h of ['ac me.com', 'acme!.com', 'acme.com$']) {
        const r = addCustomDomainDtoSchema.safeParse({ hostname: h });
        expect(r.success).toBe(false);
      }
    });

    it('rechaza hostname vacío', () => {
      const r = addCustomDomainDtoSchema.safeParse({ hostname: '' });
      expect(r.success).toBe(false);
    });

    it('rechaza hostname > 253 chars', () => {
      const tooLong =
        'a'.repeat(60) +
        '.' +
        'b'.repeat(60) +
        '.' +
        'c'.repeat(60) +
        '.' +
        'd'.repeat(60) +
        '.example.com';
      const r = addCustomDomainDtoSchema.safeParse({ hostname: tooLong });
      expect(r.success).toBe(false);
    });
  });

  describe('verifyCustomDomainDtoSchema', () => {
    it('acepta token no vacío', () => {
      const r = verifyCustomDomainDtoSchema.safeParse({ providedToken: 'abc-123' });
      expect(r.success).toBe(true);
    });

    it('rechaza token vacío', () => {
      const r = verifyCustomDomainDtoSchema.safeParse({ providedToken: '' });
      expect(r.success).toBe(false);
    });

    it('rechaza body sin token', () => {
      const r = verifyCustomDomainDtoSchema.safeParse({});
      expect(r.success).toBe(false);
    });
  });

  describe('setCustomDomainStatusDtoSchema', () => {
    it('acepta verified y inactive', () => {
      expect(setCustomDomainStatusDtoSchema.safeParse({ status: 'verified' }).success).toBe(true);
      expect(setCustomDomainStatusDtoSchema.safeParse({ status: 'inactive' }).success).toBe(true);
    });

    it('rechaza pending (transición no permitida desde aquí)', () => {
      expect(setCustomDomainStatusDtoSchema.safeParse({ status: 'pending' }).success).toBe(false);
    });

    it('rechaza valor desconocido', () => {
      expect(setCustomDomainStatusDtoSchema.safeParse({ status: 'wat' }).success).toBe(false);
    });
  });
});
