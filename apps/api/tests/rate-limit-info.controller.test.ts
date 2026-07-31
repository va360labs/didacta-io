/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del RateLimitInfoController — sexto piloto License SDK
 * (capability `feat:api.rate_limit.elevated`).
 *
 * Cobertura:
 *  1. Sin user → 401.
 *  2. Rol no admin → 403.
 *  3. Plan community → tier `community`, cifras community.
 *  4. Plan enterprise (dev bypass) → tier `enterprise`, cifras enterprise.
 *  5. Response contiene la capability + cifras de ambos tiers (frontend muestra
 *     "estás en X, podrías estar en Y").
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { LicenseService } from '@didacta/license-sdk';
import { RateLimitInfoController } from '../src/rate-limit/rate-limit-info.controller';
import { RateLimitService } from '../src/rate-limit/rate-limit.service';
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  RATE_LIMIT_ELEVATED_CAPABILITY,
} from '../src/rate-limit/rate-limit.types';
import type { SessionClaims } from '../src/auth/token.service';

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

const superAdmin: SessionClaims = {
  sub: 'user-3',
  tenantId: 'tenant-1',
  roles: ['super_admin'],
  mfaVerified: true,
};

describe('RateLimitInfoController', () => {
  let license: LicenseService;
  let service: RateLimitService;
  let controller: RateLimitInfoController;

  beforeEach(() => {
    license = new LicenseService();
    service = new RateLimitService(license, null);
    controller = new RateLimitInfoController(service);
  });

  it('[401] sin user → UnauthorizedException', () => {
    expect(() => controller.info(undefined)).toThrow(UnauthorizedException);
  });

  it('[403] rol no-admin → ForbiddenException', () => {
    expect(() => controller.info(studentUser)).toThrow(ForbiddenException);
  });

  it('[200 community] sin licencia EE → tier community y cifras community', async () => {
    await license.load({ key: null });
    const res = controller.info(adminUser);

    expect(res.tier).toBe('community');
    expect(res.authenticated.limit).toBe(DEFAULT_RATE_LIMIT_CONFIG.community.authenticated);
    expect(res.public.limit).toBe(DEFAULT_RATE_LIMIT_CONFIG.community.public);
    expect(res.authenticated.windowSeconds).toBe(DEFAULT_RATE_LIMIT_CONFIG.windowSeconds);
    expect(res.capability).toBe(RATE_LIMIT_ELEVATED_CAPABILITY);
    expect(res.capability).toBe('feat:api.rate_limit.elevated');
  });

  it('[200 enterprise] dev bypass → tier enterprise y cifras enterprise', async () => {
    await license.load({ allowDevBypass: true, key: 'dev' });
    const res = controller.info(superAdmin);

    expect(res.tier).toBe('enterprise');
    expect(res.authenticated.limit).toBe(DEFAULT_RATE_LIMIT_CONFIG.enterprise.authenticated);
    expect(res.public.limit).toBe(DEFAULT_RATE_LIMIT_CONFIG.enterprise.public);
  });

  it('[200] response expone ambos tiers (community + enterprise) para upsell UX', async () => {
    await license.load({ key: null });
    const res = controller.info(adminUser);

    expect(res.community.authenticated).toBe(DEFAULT_RATE_LIMIT_CONFIG.community.authenticated);
    expect(res.community.public).toBe(DEFAULT_RATE_LIMIT_CONFIG.community.public);
    expect(res.enterprise.authenticated).toBe(DEFAULT_RATE_LIMIT_CONFIG.enterprise.authenticated);
    expect(res.enterprise.public).toBe(DEFAULT_RATE_LIMIT_CONFIG.enterprise.public);
  });
});
