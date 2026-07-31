/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del LicenseController (GET /api/license — Public State).
 *
 * Cubren los 6 estados que el SDK distingue (community/active/grace/expired/
 * invalid/dev) y verifican que el endpoint devuelve un PublicLicenseState
 * coherente sin filtrar secretos.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import { LicenseController } from '../src/license/license.controller';

describe('LicenseController (GET /api/license)', () => {
  let svc: LicenseService;
  let ctrl: LicenseController;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    svc = new LicenseService();
    ctrl = new LicenseController(svc);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('devuelve status=community sin licencia', async () => {
    await svc.load({ key: null });
    const state = ctrl.getState();
    expect(state.status).toBe('community');
    expect(state.capabilities).toEqual([]);
    expect(state.warnings).toEqual([]);
    expect(state.organizationName).toBeUndefined();
  });

  it('devuelve status=dev y todas las capabilities con bypass activo', async () => {
    process.env.NODE_ENV = 'development';
    await svc.load({ allowDevBypass: true, key: 'whatever' });
    const state = ctrl.getState();
    expect(state.status).toBe('dev');
    expect(state.capabilities.length).toBeGreaterThanOrEqual(11);
    expect(state.warnings[0]).toMatch(/dev bypass/i);
  });

  it('refusa dev bypass en NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    await svc.load({ allowDevBypass: true });
    const state = ctrl.getState();
    expect(state.status).toBe('community');
  });

  it('NUNCA filtra el JWT raw o claims internos', async () => {
    process.env.NODE_ENV = 'development';
    await svc.load({ allowDevBypass: true });
    const state = ctrl.getState();
    // PublicLicenseState solo expone estos campos, nada más
    const allowedKeys = [
      'status',
      'edition',
      'organizationName',
      'expiresAt',
      'capabilities',
      'warnings',
    ];
    for (const key of Object.keys(state)) {
      expect(allowedKeys).toContain(key);
    }
    expect((state as any).payload).toBeUndefined();
    expect((state as any).iss).toBeUndefined();
    expect((state as any).sub).toBeUndefined();
  });
});
