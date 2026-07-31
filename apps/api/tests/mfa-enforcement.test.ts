/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del enforcement de la política MFA tenant-wide en el flujo de login.
 *
 * El comportamiento se concentra en `MfaPolicyService.evaluateLoginPolicy`,
 * que es lo que `AuthService.signin` llama. Probamos todas las ramas:
 *
 *   - User sin MFA, política off → allow.
 *   - User sin MFA, capability EE inactiva (failsafe) → allow.
 *   - User sin MFA, política ON, dentro del grace → warn + setup URL.
 *   - User sin MFA, política ON, FUERA del grace → block.
 *   - User con MFA, política ON → allow.
 *   - User admin (super_admin / tenant_admin), política ON → allow
 *     (los admin ya están cubiertos por LMS-109; no duplicamos enforcement).
 *
 * Los efectos secundarios (audit log + throw del error) se prueban a través
 * del comportamiento real de auth.service.signin en otra suite de
 * integración (al levantar la app completa). Aquí cubrimos la lógica pura.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LicenseService, LICENSE_CAPABILITIES } from '@didacta/license-sdk';
import { MfaPolicyService } from '../src/auth/mfa-policy/mfa-policy.service';
import {
  defaultMfaPolicy,
  MFA_POLICY_KEY,
  MFA_POLICY_MODULE_NAME,
  type MfaPolicyState,
} from '../src/auth/mfa-policy/mfa-policy.types';
import { MfaRequiredByTenantPolicyError } from '../src/auth/mfa-policy/mfa-required-by-tenant-policy.error';

type FakeTenantConfig = ConstructorParameters<typeof MfaPolicyService>[0];

const ONE_DAY = 86_400_000;

function makeTenantConfig(stored?: MfaPolicyState | undefined): FakeTenantConfig {
  return {
    get: vi.fn().mockResolvedValue(stored),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeTenantConfig;
}

const STUDENT = { mfaEnabled: false, roles: ['alumno'] as const };
const STUDENT_WITH_MFA = { mfaEnabled: true, roles: ['alumno'] as const };
const FORMADOR = { mfaEnabled: false, roles: ['formador'] as const };
const TENANT_ADMIN = { mfaEnabled: false, roles: ['tenant_admin'] as const };
const SUPER_ADMIN = { mfaEnabled: false, roles: ['super_admin'] as const };

describe('MfaPolicyService.evaluateLoginPolicy · enforcement (A.1)', () => {
  let license: LicenseService;

  beforeEach(() => {
    license = new LicenseService();
  });

  describe('failsafe: capability EE inactiva (community)', () => {
    beforeEach(async () => {
      await license.load({ key: null });
    });

    it('user sin MFA + política ON tenant-wide → allow (la licencia EE no está activa)', async () => {
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 7,
        updatedAt: new Date(Date.now() - 30 * ONE_DAY).toISOString(), // hace 30 días
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', STUDENT);
      expect(outcome.outcome).toBe('allow');
      // Defensa: ni siquiera consultamos la DB cuando la capability está off
      // — esto es un microoptimization (failsafe primero, query después).
      expect(tenantConfig.get).not.toHaveBeenCalled();
    });
  });

  describe('capability EE activa (dev bypass)', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('NO hay política persistida → allow', async () => {
      const tenantConfig = makeTenantConfig(undefined);
      const service = new MfaPolicyService(tenantConfig, license);
      const outcome = await service.evaluateLoginPolicy('tenant-1', STUDENT);
      expect(outcome.outcome).toBe('allow');
    });

    it('política off (requiredForAll=false) → allow', async () => {
      const tenantConfig = makeTenantConfig(defaultMfaPolicy());
      const service = new MfaPolicyService(tenantConfig, license);
      const outcome = await service.evaluateLoginPolicy('tenant-1', STUDENT);
      expect(outcome.outcome).toBe('allow');
    });

    it('política ON + user con MFA → allow', async () => {
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 7,
        updatedAt: new Date(Date.now() - 30 * ONE_DAY).toISOString(),
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', STUDENT_WITH_MFA);
      expect(outcome.outcome).toBe('allow');
    });

    it('política ON + user sin MFA, dentro del grace (3 de 7 días) → warn', async () => {
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 7,
        updatedAt: new Date(Date.now() - 3 * ONE_DAY).toISOString(),
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', STUDENT);
      expect(outcome.outcome).toBe('warn');
      if (outcome.outcome === 'warn') {
        expect(outcome.gracePeriodDays).toBe(7);
        expect(outcome.setupUrl).toBe('/mfa/setup');
        // El expiresAt debería ser ~4 días en el futuro.
        const expiresInMs = new Date(outcome.gracePeriodExpiresAt).getTime() - Date.now();
        expect(expiresInMs).toBeGreaterThan(3.5 * ONE_DAY);
        expect(expiresInMs).toBeLessThan(4.5 * ONE_DAY);
      }
    });

    it('política ON + user sin MFA, JUSTO en el límite del grace → warn (≤)', async () => {
      // 7 días exactos de gracia, política activada hace 7 días → todavía dentro.
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 7,
        updatedAt: new Date(Date.now() - 7 * ONE_DAY + 1000).toISOString(),
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', STUDENT);
      expect(outcome.outcome).toBe('warn');
    });

    it('política ON + user sin MFA, FUERA del grace (8 de 7 días) → block', async () => {
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 7,
        updatedAt: new Date(Date.now() - 8 * ONE_DAY).toISOString(),
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', STUDENT);
      expect(outcome.outcome).toBe('block');
      if (outcome.outcome === 'block') {
        expect(outcome.gracePeriodDays).toBe(7);
        expect(outcome.setupUrl).toBe('/mfa/setup');
      }
    });

    it('formador (no admin) sin MFA, política ON, fuera de grace → block', async () => {
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 1,
        updatedAt: new Date(Date.now() - 5 * ONE_DAY).toISOString(),
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', FORMADOR);
      expect(outcome.outcome).toBe('block');
    });

    it('tenant_admin sin MFA, política ON → allow (cubierto por LMS-109)', async () => {
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 1,
        updatedAt: new Date(Date.now() - 30 * ONE_DAY).toISOString(),
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', TENANT_ADMIN);
      expect(outcome.outcome).toBe('allow');
    });

    it('super_admin sin MFA, política ON → allow (cubierto por LMS-109)', async () => {
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 1,
        updatedAt: new Date(Date.now() - 30 * ONE_DAY).toISOString(),
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', SUPER_ADMIN);
      expect(outcome.outcome).toBe('allow');
    });

    it('grace period 30 días → respeta el plazo extendido', async () => {
      const policy: MfaPolicyState = {
        requiredForAll: true,
        gracePeriodDays: 30,
        updatedAt: new Date(Date.now() - 25 * ONE_DAY).toISOString(),
        updatedBy: 'admin-1',
      };
      const tenantConfig = makeTenantConfig(policy);
      const service = new MfaPolicyService(tenantConfig, license);

      const outcome = await service.evaluateLoginPolicy('tenant-1', STUDENT);
      expect(outcome.outcome).toBe('warn');
    });
  });
});

describe('MfaRequiredByTenantPolicyError · contract', () => {
  it('expone code, statusCode 401 y body con setupUrl', () => {
    const err = new MfaRequiredByTenantPolicyError({
      gracePeriodDays: 7,
      gracePeriodExpiredAt: '2026-01-01T00:00:00.000Z',
      setupUrl: '/mfa/setup',
    });
    expect(err.getStatus()).toBe(401);
    const response = err.getResponse() as Record<string, unknown>;
    expect(response.code).toBe('mfa_required_by_tenant_policy');
    expect(response.setupUrl).toBe('/mfa/setup');
    expect(response.gracePeriodDays).toBe(7);
    expect(response.gracePeriodExpiredAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('MfaPolicyService.getPolicy · estado para el frontend', () => {
  let license: LicenseService;

  beforeEach(() => {
    license = new LicenseService();
  });

  it('community + sin política persistida → defaults + licensed=false', async () => {
    await license.load({ key: null });
    const tenantConfig = makeTenantConfig(undefined);
    const service = new MfaPolicyService(tenantConfig, license);

    const res = await service.getPolicy('tenant-1');
    expect(res.licensed).toBe(false);
    expect(res.enforcementActive).toBe(false);
    expect(res.policy.requiredForAll).toBe(false);
    expect(res.policy.gracePeriodDays).toBe(7);
  });

  it('dev bypass + política activada → licensed=true + enforcementActive=true', async () => {
    await license.load({ allowDevBypass: true, key: 'dev-key' });
    const policy: MfaPolicyState = {
      requiredForAll: true,
      gracePeriodDays: 14,
      updatedAt: new Date().toISOString(),
      updatedBy: 'admin-1',
    };
    const tenantConfig = makeTenantConfig(policy);
    const service = new MfaPolicyService(tenantConfig, license);

    const res = await service.getPolicy('tenant-1');
    expect(res.licensed).toBe(true);
    expect(res.enforcementActive).toBe(true);
    expect(res.policy.requiredForAll).toBe(true);
    expect(res.policy.gracePeriodDays).toBe(14);
  });

  it('community + política persistida con requiredForAll=true → enforcementActive=false', async () => {
    // Caso real: admin tenía licencia EE, activó la política, la licencia
    // expiró. La política sigue persistida pero el enforcement queda inerte.
    await license.load({ key: null });
    const policy: MfaPolicyState = {
      requiredForAll: true,
      gracePeriodDays: 7,
      updatedAt: new Date().toISOString(),
      updatedBy: 'admin-1',
    };
    const tenantConfig = makeTenantConfig(policy);
    const service = new MfaPolicyService(tenantConfig, license);

    const res = await service.getPolicy('tenant-1');
    expect(res.licensed).toBe(false);
    expect(res.enforcementActive).toBe(false);
    // La política sigue ahí — si el admin renueva la licencia, vuelve viva sin tocar nada.
    expect(res.policy.requiredForAll).toBe(true);
  });
});
