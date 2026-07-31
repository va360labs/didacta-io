/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del gate `feat:audit.long_retention` aplicado a `GET /audit/entries`
 * y al endpoint informativo `/audit/retention-info`. Segunda capability EE
 * piloto, complemento de MIG-026 (white-label) — valida que el SDK escala más
 * allá de un único caso.
 *
 * En plan community, el dateFrom efectivo se trunca a `now - 90d`. Con la
 * capability activa, el rango es ilimitado.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import { AuditController, COMMUNITY_AUDIT_RETENTION_DAYS } from '../src/modules/audit.controller';

const adminUser = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  roles: ['tenant_admin'],
  email: 'admin@tenant.test',
} as Parameters<AuditController['list']>[0];

function makeAuditLog(spy: ReturnType<typeof vi.fn>) {
  return { list: spy } as unknown as ConstructorParameters<typeof AuditController>[0];
}

describe('AuditController · gate feat:audit.long_retention (B5)', () => {
  let license: LicenseService;
  let listSpy: ReturnType<typeof vi.fn>;
  let controller: AuditController;

  beforeEach(() => {
    license = new LicenseService();
    listSpy = vi.fn().mockResolvedValue([]);
    controller = new AuditController(makeAuditLog(listSpy), license);
  });

  describe('community (sin licencia)', () => {
    beforeEach(async () => {
      await license.load({ key: null });
    });

    it('GET /entries sin dateFrom → aplica floor de 90d', async () => {
      await controller.list(adminUser);
      expect(listSpy).toHaveBeenCalledTimes(1);
      const args = listSpy.mock.calls[0][1];
      expect(args.dateFrom).toBeInstanceOf(Date);
      const floorMs = Date.now() - COMMUNITY_AUDIT_RETENTION_DAYS * 86_400_000;
      // Tolerancia: el floor se calcula al momento exacto de la llamada.
      expect(Math.abs(args.dateFrom.getTime() - floorMs)).toBeLessThan(1000);
    });

    it('GET /entries con dateFrom MUY antiguo → trunca al floor', async () => {
      const veryOld = new Date(Date.now() - 365 * 86_400_000).toISOString();
      await controller.list(adminUser, undefined, undefined, undefined, veryOld);
      const args = listSpy.mock.calls[0][1];
      const floorMs = Date.now() - COMMUNITY_AUDIT_RETENTION_DAYS * 86_400_000;
      expect(args.dateFrom.getTime()).toBeGreaterThanOrEqual(floorMs - 1000);
      expect(args.dateFrom.getTime()).toBeLessThanOrEqual(floorMs + 1000);
    });

    it('GET /entries con dateFrom RECIENTE (30d) → respeta la fecha pedida', async () => {
      const recent = new Date(Date.now() - 30 * 86_400_000);
      await controller.list(adminUser, undefined, undefined, undefined, recent.toISOString());
      const args = listSpy.mock.calls[0][1];
      // Tolerancia ms por el round-trip ISO string.
      expect(Math.abs(args.dateFrom.getTime() - recent.getTime())).toBeLessThan(1000);
    });

    it('GET /retention-info → community + maxDays 90', () => {
      const info = controller.retentionInfo(adminUser);
      expect(info.plan).toBe('community');
      expect(info.maxDays).toBe(COMMUNITY_AUDIT_RETENTION_DAYS);
      expect(info.capability).toBe('feat:audit.long_retention');
    });
  });

  describe('con dev bypass (capability activa)', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('GET /entries con dateFrom MUY antiguo → no trunca', async () => {
      const veryOld = new Date(Date.now() - 365 * 86_400_000);
      await controller.list(adminUser, undefined, undefined, undefined, veryOld.toISOString());
      const args = listSpy.mock.calls[0][1];
      expect(Math.abs(args.dateFrom.getTime() - veryOld.getTime())).toBeLessThan(1000);
    });

    it('GET /entries sin dateFrom → no aplica floor', async () => {
      await controller.list(adminUser);
      const args = listSpy.mock.calls[0][1];
      expect(args.dateFrom).toBeUndefined();
    });

    it('GET /retention-info → enterprise + maxDays null', () => {
      const info = controller.retentionInfo(adminUser);
      expect(info.plan).toBe('enterprise');
      expect(info.maxDays).toBeNull();
    });
  });
});
