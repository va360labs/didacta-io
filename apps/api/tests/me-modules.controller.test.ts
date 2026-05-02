/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del endpoint `GET /me/modules` (gating UI del sidebar).
 *
 * Reglas:
 *  - Sin auth → 401 (cubierto por JwtAuthGuard, no por el controller).
 *  - Devuelve los módulos `enabled=true` del tenant del JWT.
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
    const ctrl = new MeModulesController(
      ...([tenantModules, license] as unknown as ServiceCtor),
    );
    const result = await ctrl.list(makeUser());
    expect(result.activeModules).toEqual(['mod.courses', 'mod.zoom-live']);
    expect(tenantModules.list).toHaveBeenCalledWith('tenant-1');
  });

  it('devuelve enabledCapabilities=[] sin licencia (community)', async () => {
    await license.load({ key: null });
    const ctrl = new MeModulesController(
      ...([makeTenantModules([]), license] as unknown as ServiceCtor),
    );
    const result = await ctrl.list(makeUser());
    expect(result.enabledCapabilities).toEqual([]);
  });

  it('devuelve TODAS las capabilities con dev bypass', async () => {
    await license.load({ allowDevBypass: true, key: 'dev-key' });
    const ctrl = new MeModulesController(
      ...([makeTenantModules([]), license] as unknown as ServiceCtor),
    );
    const result = await ctrl.list(makeUser());
    expect(result.enabledCapabilities).toContain('feat:multi_tenant.real');
    expect(result.enabledCapabilities).toContain('feat:scim');
    expect(result.enabledCapabilities.length).toBeGreaterThanOrEqual(11);
  });

  it('lanza UnauthorizedException sin user (defensa-en-profundidad)', async () => {
    await license.load({ key: null });
    const ctrl = new MeModulesController(
      ...([makeTenantModules([]), license] as unknown as ServiceCtor),
    );
    await expect(ctrl.list(undefined)).rejects.toThrow(/Unauthorized/);
  });
});
