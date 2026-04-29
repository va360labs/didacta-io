/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del RegistryService (MIG-027 — opt-in instalaciones Community).
 *
 * Mockean Prisma + el RegistryClient del SDK. Validan los tres flujos:
 *  - opt-in con DIDACTA_REGISTRY_URL configurada y sin configurar.
 *  - getStatus con / sin registro activo.
 *  - opt-out best-effort cuando Cloud god es inalcanzable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import { RegistryService } from '../src/registry/registry.service';

interface FakeRow {
  id: string;
  installationId: string;
  email: string;
  organizationName: string;
  deploymentUrl: string | null;
  registryToken: string | null;
  termsAcceptedAt: Date;
  optInAt: Date;
  optedOutAt: Date | null;
  lastTelemetryAt: Date | null;
  telemetryEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function makePrismaMock() {
  const rows: FakeRow[] = [];
  return {
    rows,
    installationRegistry: {
      findFirst: vi.fn(async (args: { where: any; orderBy?: any }) => {
        const where = args?.where ?? {};
        const filtered = rows.filter((r) => {
          if (where.optedOutAt === null) return r.optedOutAt === null;
          if (where.telemetryEnabled === true) return r.telemetryEnabled === true;
          return true;
        });
        return filtered[filtered.length - 1] ?? null;
      }),
      updateMany: vi.fn(async (args: any) => {
        const updated = rows.filter(
          (r) => args.where.optedOutAt === null && r.optedOutAt === null,
        );
        for (const r of updated) {
          Object.assign(r, args.data);
        }
        return { count: updated.length };
      }),
      create: vi.fn(async (args: any) => {
        const row: FakeRow = {
          id: `row_${rows.length + 1}`,
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async (args: any) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      }),
    },
    user: { count: vi.fn(async () => 0) },
    modCoursesCourse: { count: vi.fn(async () => 0) },
  };
}

describe('RegistryService (MIG-027)', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let license: LicenseService;
  let svc: RegistryService;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    prisma = makePrismaMock();
    license = new LicenseService();
    await license.load({ key: null });
    svc = new RegistryService(prisma as any, license);
    delete process.env['DIDACTA_REGISTRY_URL'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getStatus', () => {
    it('sin registros, devuelve registered=false', async () => {
      const status = await svc.getStatus();
      expect(status.registered).toBe(false);
      expect(status.installationId).toBeNull();
      expect(status.registryConnected).toBe(false);
    });

    it('refleja DIDACTA_REGISTRY_URL si está configurada', async () => {
      process.env['DIDACTA_REGISTRY_URL'] = 'https://cloud.didacta.io/registry';
      const status = await svc.getStatus();
      expect(status.registryUrl).toBe('https://cloud.didacta.io/registry');
    });
  });

  describe('optIn', () => {
    it('persiste localmente y devuelve registered=true cuando REGISTRY_URL no está', async () => {
      const status = await svc.optIn({
        email: 'admin@academia.example',
        organizationName: 'Academia Ejemplo',
        acceptTerms: true,
      });

      expect(status.registered).toBe(true);
      expect(status.email).toBe('admin@academia.example');
      expect(status.organizationName).toBe('Academia Ejemplo');
      expect(status.installationId).toBeTruthy();
      expect(status.registryConnected).toBe(false); // no Cloud god
      expect(prisma.installationRegistry.create).toHaveBeenCalledOnce();
    });

    it('marca opted-out cualquier registro previo activo (singleton lógico)', async () => {
      await svc.optIn({
        email: 'first@example.com',
        organizationName: 'First Org',
        acceptTerms: true,
      });
      await svc.optIn({
        email: 'second@example.com',
        organizationName: 'Second Org',
        acceptTerms: true,
      });

      // 2 filas, primera opted-out, segunda activa
      expect(prisma.rows.length).toBe(2);
      const active = prisma.rows.filter((r) => r.optedOutAt === null);
      expect(active.length).toBe(1);
      expect(active[0]!.email).toBe('second@example.com');
    });

    it('rechaza si acceptTerms !== true', async () => {
      await expect(
        svc.optIn({
          email: 'x@y.com',
          organizationName: 'X',
          // @ts-expect-error: probando rechazo runtime
          acceptTerms: false,
        }),
      ).rejects.toThrow();
    });
  });

  describe('optOut', () => {
    it('marca optedOutAt en el registro activo', async () => {
      await svc.optIn({
        email: 'admin@x.com',
        organizationName: 'X',
        acceptTerms: true,
      });
      const status = await svc.optOut();
      expect(status.registered).toBe(false);
      expect(prisma.rows[0]!.optedOutAt).toBeInstanceOf(Date);
    });

    it('no rompe si no hay registro activo', async () => {
      const status = await svc.optOut();
      expect(status.registered).toBe(false);
    });
  });

  describe('buildTelemetrySnapshot', () => {
    it('devuelve null sin registro', async () => {
      const snap = await svc.buildTelemetrySnapshot();
      expect(snap).toBeNull();
    });

    it('devuelve snapshot agregado sin PII con registro activo', async () => {
      await svc.optIn({
        email: 'a@b.c',
        organizationName: 'Org',
        acceptTerms: true,
      });
      const snap = await svc.buildTelemetrySnapshot();
      expect(snap).toBeTruthy();
      expect(snap?.installationId).toBe(prisma.rows[0]!.installationId);
      expect(snap?.users).toBe(0);
      expect(snap?.courses).toBe(0);
      expect(snap?.licensePlan).toBe('community');
      // No debe haber emails ni nombres de usuarios
      expect(JSON.stringify(snap)).not.toContain('a@b.c');
      expect(JSON.stringify(snap)).not.toContain('Org');
    });
  });
});
