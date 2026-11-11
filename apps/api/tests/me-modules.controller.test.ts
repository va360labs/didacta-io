/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del endpoint `GET /me/modules` (gating UI del sidebar).
 *
 * Reglas:
 *  - Sin auth → 401 (cubierto por JwtAuthGuard, no por el controller).
 *  - Devuelve los módulos `enabled=true` del tenant del JWT.
 *  - Mergea third-party de `installed_module.status='INSTALLED'`.
 *  - `enabledCapabilities` refleja exactamente las capabilities activas en
 *    LicenseService (subset de ALL_CAPABILITIES).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import { MeModulesController } from '../src/modules/me-modules.controller';
import type { SessionClaims } from '../src/auth/token.service';

type ServiceCtor = ConstructorParameters<typeof MeModulesController>;

function makeTenantModules(items: Array<{ name: string; enabled: boolean }>) {
  return {
    list: vi.fn().mockResolvedValue(
      items.map((it) => ({
        name: it.name,
        version: '1.0.0',
        displayName: it.name,
        description: null,
        enabled: it.enabled,
        enabledByDefault: false,
        dependencies: [],
        dependents: [],
        optionalDependencies: [],
        enabledAt: null,
        updatedAt: null,
      })),
    ),
  };
}

function makePrisma(installedNames: string[] = []) {
  return {
    installedModule: {
      findMany: vi.fn().mockResolvedValue(installedNames.map((name) => ({ name }))),
    },
  };
}

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-1',
    roles: ['tenant_admin'],
    mfaVerified: true,
    kind: 'access',
    iss: 'https://didacta.local',
    aud: 'didacta-api',
    iat: 0,
    exp: 0,
    ...overrides,
  } as SessionClaims;
}

describe('MeModulesController · GET /me/modules', () => {
  let license: LicenseService;

  beforeEach(() => {
    license = new LicenseService();
  });

  it('devuelve solo los módulos activos del tenant', async () => {
    await license.load({ key: null });
    const tenantModules = makeTenantModules([
      { name: 'mod.courses', enabled: true },
      { name: 'mod.community', enabled: false },
      { name: 'mod.zoom-live', enabled: true },
    ]);
    const prisma = makePrisma();
    const ctrl = new MeModulesController(
      ...([tenantModules, license, prisma] as unknown as ServiceCtor),
    );
    const result = await ctrl.list(makeUser());
    expect(result.activeModules).toEqual(['mod.courses', 'mod.zoom-live']);
    expect(tenantModules.list).toHaveBeenCalledWith('tenant-1');
  });

  it('REGRESIÓN: mergea módulos third-party instalados (installed_module.status=INSTALLED)', async () => {
    await license.load({ key: null });
    const tenantModules = makeTenantModules([{ name: 'mod.courses', enabled: true }]);
    const prisma = makePrisma(['mod.migrator-learndash']);
    const ctrl = new MeModulesController(
      ...([tenantModules, license, prisma] as unknown as ServiceCtor),
    );
    const result = await ctrl.list(makeUser());
    expect(result.activeModules).toEqual(
      expect.arrayContaining(['mod.courses', 'mod.migrator-learndash']),
    );
    expect(prisma.installedModule.findMany).toHaveBeenCalledWith({
      where: { status: 'INSTALLED' },
      select: { name: true },
    });
  });

  it('REGRESIÓN: dedupe si un nombre aparece tanto en built-in activo como en installed_module', async () => {
    await license.load({ key: null });
    const tenantModules = makeTenantModules([{ name: 'mod.courses', enabled: true }]);
    const prisma = makePrisma(['mod.courses']);
    const ctrl = new MeModulesController(
      ...([tenantModules, license, prisma] as unknown as ServiceCtor),
    );
    const result = await ctrl.list(makeUser());
    expect(result.activeModules.filter((n) => n === 'mod.courses')).toHaveLength(1);
  });

  it('devuelve enabledCapabilities=[] sin licencia (community)', async () => {
    await license.load({ key: null });
    const ctrl = new MeModulesController(
      ...([makeTenantModules([]), license, makePrisma()] as unknown as ServiceCtor),
    );
    const result = await ctrl.list(makeUser());
    expect(result.enabledCapabilities).toEqual([]);
  });

  it('devuelve TODAS las capabilities con dev bypass', async () => {
    await license.load({ allowDevBypass: true, key: 'dev-key' });
    const ctrl = new MeModulesController(
      ...([makeTenantModules([]), license, makePrisma()] as unknown as ServiceCtor),
    );
    const result = await ctrl.list(makeUser());
    expect(result.enabledCapabilities).toContain('feat:multi_tenant.real');
    expect(result.enabledCapabilities).toContain('feat:scim');
    expect(result.enabledCapabilities.length).toBeGreaterThanOrEqual(11);
  });

  it('lanza UnauthorizedException sin user (defensa-en-profundidad)', async () => {
    await license.load({ key: null });
    const ctrl = new MeModulesController(
      ...([makeTenantModules([]), license, makePrisma()] as unknown as ServiceCtor),
    );
    await expect(ctrl.list(undefined)).rejects.toThrow(/Unauthorized/);
  });

  describe('puerta de suscripción', () => {
    const ENDS = new Date('2026-11-18T18:00:00.000Z');
    const URL = 'https://didacta.io/es/pricing?upgrade=tok';
    function gate(state: 'OPEN' | 'TRIAL' | 'LOCKED') {
      return {
        gateFor: vi
          .fn()
          .mockResolvedValue(
            state === 'OPEN'
              ? { state, trialEndsAt: null, actionUrl: null }
              : { state, trialEndsAt: ENDS, actionUrl: URL },
          ),
      };
    }
    async function listWith(state: 'OPEN' | 'TRIAL' | 'LOCKED', roles: string[]) {
      await license.load({ key: null });
      const ctrl = new MeModulesController(
        ...([makeTenantModules([]), license, makePrisma(), gate(state)] as unknown as ServiceCtor),
      );
      return (await ctrl.list(makeUser({ roles }))).subscriptionGate;
    }

    it('el administrador ve la prueba entera, con fecha y enlace de pago', async () => {
      expect(await listWith('TRIAL', ['tenant_admin'])).toEqual({
        state: 'TRIAL',
        trialEndsAt: ENDS.toISOString(),
        actionUrl: URL,
      });
    });

    it('un alumno NO ve la prueba ni el enlace: para él el aula está abierta', async () => {
      expect(await listWith('TRIAL', ['alumno'])).toEqual({
        state: 'OPEN',
        trialEndsAt: null,
        actionUrl: null,
      });
    });

    it('con el aula en pausa, el alumno sabe que está en pausa pero no recibe el enlace', async () => {
      expect(await listWith('LOCKED', ['alumno'])).toEqual({
        state: 'LOCKED',
        trialEndsAt: null,
        actionUrl: null,
      });
      expect((await listWith('LOCKED', ['super_admin']))?.actionUrl).toBe(URL);
    });

    it('sin el servicio (instalación sin puerta) responde OPEN', async () => {
      await license.load({ key: null });
      const ctrl = new MeModulesController(
        ...([makeTenantModules([]), license, makePrisma()] as unknown as ServiceCtor),
      );
      expect((await ctrl.list(makeUser())).subscriptionGate.state).toBe('OPEN');
    });
  });
});
