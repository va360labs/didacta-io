/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del MfaPolicyController — tercer piloto License SDK.
 *
 * Aspectos cubiertos:
 *  - PUT sin licencia → CapabilityRequiredError (mapea a 402 vía filter global).
 *  - PUT con dev bypass → permite cambiar política y persiste.
 *  - GET disponible siempre (lectura para admin) — community + EE.
 *  - Cambio de política → entry audit log con previous/next.
 *  - Validación: gracePeriodDays debe ser 1-90 entero.
 *  - Acceso restringido a super_admin / tenant_admin.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LicenseService,
  LICENSE_CAPABILITIES,
  CapabilityRequiredError,
} from '@didacta/license-sdk';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { MfaPolicyController } from '../src/auth/mfa-policy/mfa-policy.controller';
import { MfaPolicyService } from '../src/auth/mfa-policy/mfa-policy.service';
import { updateMfaPolicyDtoSchema } from '../src/auth/mfa-policy/mfa-policy.dto';
import { MFA_POLICY_KEY, MFA_POLICY_MODULE_NAME } from '../src/auth/mfa-policy/mfa-policy.types';
import type { SessionClaims } from '../src/auth/token.service';

type FakeTenantConfig = ConstructorParameters<typeof MfaPolicyService>[0];
type FakeAuditLog = ConstructorParameters<typeof MfaPolicyController>[1];

function makeTenantConfig(
  opts: {
    initial?: unknown;
    setSpy?: ReturnType<typeof vi.fn>;
  } = {},
): FakeTenantConfig {
  const setSpy = opts.setSpy ?? vi.fn().mockResolvedValue(undefined);
  let stored = opts.initial;
  return {
    get: vi.fn().mockImplementation(async () => stored),
    set: vi.fn().mockImplementation(async (...args: unknown[]) => {
      // args: [tenantId, moduleName, key, value, options]
      stored = args[3];
      return setSpy(...args);
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
  MfaPolicyController['update']
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

describe('MfaPolicyController · gate feat:mfa.enforcement (A.1)', () => {
  let license: LicenseService;
  let tenantConfig: FakeTenantConfig;
  let policyService: MfaPolicyService;
  let auditLog: FakeAuditLog;
  let recordSpy: ReturnType<typeof vi.fn>;
  let controller: MfaPolicyController;

  beforeEach(() => {
    license = new LicenseService();
    tenantConfig = makeTenantConfig();
    policyService = new MfaPolicyService(tenantConfig, license);
    const a = makeAuditLog();
    auditLog = a.audit;
    recordSpy = a.recordSpy;
    controller = new MfaPolicyController(policyService, auditLog);
  });

  describe('community (sin licencia)', () => {
    beforeEach(async () => {
      await license.load({ key: null });
    });

    it('GET disponible — devuelve defaults con licensed=false y enforcementActive=false', async () => {
      const res = await controller.get(adminUser);
      expect(res.policy.requiredForAll).toBe(false);
      expect(res.policy.gracePeriodDays).toBe(7);
      expect(res.licensed).toBe(false);
      expect(res.enforcementActive).toBe(false);
      expect(res.capability).toBe(LICENSE_CAPABILITIES.MFA_ENFORCEMENT);
    });

    it('PUT lanza CapabilityRequiredError → mapea a 402 por filter global', async () => {
      // Simulamos lo que hace LicenseGuard en runtime (no podemos ejecutar
      // el guard real aquí sin levantar Nest; eso lo cubre la suite de
      // integración). Lo que SÍ podemos verificar es que cuando la
      // capability NO está en el state, el SDK lanza el error tipado.
      expect(() => license.requireCapability(LICENSE_CAPABILITIES.MFA_ENFORCEMENT)).toThrow(
        CapabilityRequiredError,
      );
    });
  });

  describe('con dev bypass (capability activa)', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('PUT permite activar la política y persiste', async () => {
      const dto = { requiredForAll: true, gracePeriodDays: 14 };
      const res = await controller.update(FAKE_REQ, adminUser, dto);

      expect(res.policy.requiredForAll).toBe(true);
      expect(res.policy.gracePeriodDays).toBe(14);
      expect(res.policy.updatedBy).toBe('user-1');
      expect(res.enforcementActive).toBe(true);
      expect(res.licensed).toBe(true);

      // Persistencia delegada a tenantConfig.set con isSecret=false.
      expect(tenantConfig.set).toHaveBeenCalledWith(
        'tenant-1',
        MFA_POLICY_MODULE_NAME,
        MFA_POLICY_KEY,
        expect.objectContaining({ requiredForAll: true, gracePeriodDays: 14 }),
        expect.objectContaining({ isSecret: false, actorId: 'user-1' }),
      );
    });

    it('PUT registra entry audit log con previous + next', async () => {
      // Primer cambio: previous = defaults, next = activa con 7 días.
      await controller.update(FAKE_REQ, adminUser, {
        requiredForAll: true,
        gracePeriodDays: 7,
      });
      expect(recordSpy).toHaveBeenCalledTimes(1);
      const entry = recordSpy.mock.calls[0][0];
      expect(entry.action).toBe('auth.mfa_policy.updated');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.actorId).toBe('user-1');
      expect(entry.metadata.previous).toEqual({
        requiredForAll: false,
        gracePeriodDays: 7,
      });
      expect(entry.metadata.next).toEqual({
        requiredForAll: true,
        gracePeriodDays: 7,
      });
    });

    it('PUT segundo cambio referencia el estado anterior real', async () => {
      await controller.update(FAKE_REQ, adminUser, {
        requiredForAll: true,
        gracePeriodDays: 30,
      });
      await controller.update(FAKE_REQ, adminUser, {
        requiredForAll: true,
        gracePeriodDays: 3,
      });
      expect(recordSpy).toHaveBeenCalledTimes(2);
      const entry2 = recordSpy.mock.calls[1][0];
      expect(entry2.metadata.previous).toEqual({
        requiredForAll: true,
        gracePeriodDays: 30,
      });
      expect(entry2.metadata.next).toEqual({
        requiredForAll: true,
        gracePeriodDays: 3,
      });
    });

    it('PUT permite desactivar la política', async () => {
      await controller.update(FAKE_REQ, adminUser, {
        requiredForAll: true,
        gracePeriodDays: 7,
      });
      const res = await controller.update(FAKE_REQ, adminUser, {
        requiredForAll: false,
        gracePeriodDays: 7,
      });
      expect(res.policy.requiredForAll).toBe(false);
      expect(res.enforcementActive).toBe(false);
    });
  });

  describe('autorización por rol', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('GET sin user → UnauthorizedException', async () => {
      await expect(controller.get(undefined)).rejects.toThrow(UnauthorizedException);
    });

    it('PUT con rol alumno → ForbiddenException', async () => {
      await expect(
        controller.update(FAKE_REQ, studentUser, {
          requiredForAll: true,
          gracePeriodDays: 7,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('PUT con rol super_admin → permitido', async () => {
      const superAdmin: SessionClaims = {
        ...adminUser,
        roles: ['super_admin'],
      };
      const res = await controller.update(FAKE_REQ, superAdmin, {
        requiredForAll: true,
        gracePeriodDays: 7,
      });
      expect(res.policy.requiredForAll).toBe(true);
    });
  });
});

describe('MfaPolicyController · validación de DTO (Zod)', () => {
  it('rechaza gracePeriodDays = 0', () => {
    const result = updateMfaPolicyDtoSchema.safeParse({
      requiredForAll: true,
      gracePeriodDays: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rechaza gracePeriodDays = 91', () => {
    const result = updateMfaPolicyDtoSchema.safeParse({
      requiredForAll: true,
      gracePeriodDays: 91,
    });
    expect(result.success).toBe(false);
  });

  it('rechaza gracePeriodDays no entero', () => {
    const result = updateMfaPolicyDtoSchema.safeParse({
      requiredForAll: true,
      gracePeriodDays: 7.5,
    });
    expect(result.success).toBe(false);
  });

  it('acepta gracePeriodDays en rango (1-90)', () => {
    for (const d of [1, 7, 30, 90]) {
      const result = updateMfaPolicyDtoSchema.safeParse({
        requiredForAll: true,
        gracePeriodDays: d,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rechaza requiredForAll faltante', () => {
    const result = updateMfaPolicyDtoSchema.safeParse({ gracePeriodDays: 7 });
    expect(result.success).toBe(false);
  });
});
