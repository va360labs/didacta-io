/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Alta de un aula desde Didacta Cloud (ensayo general del 14-nov-2026):
 *
 *  - la creadora recibe SU bienvenida («Tu academia X está lista»), no el
 *    correo de «restablecer tu contraseña», y con validez de 7 días;
 *  - el nombre que escribió en el alta (`adminName`) llega a su perfil.
 */

import { LicenseService } from '@didacta/license-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantSchema } from '../src/admin/admin-tenants.controller';
import { AdminTenantsService } from '../src/admin/admin-tenants.service';

type ServiceCtor = ConstructorParameters<typeof AdminTenantsService>;

const TENANT_ID = 'tenant-nuevo';
const CLOUD = {
  kind: 'provisioning',
  credentialId: '11111111-2222-3333-4444-555555555555',
} as const;

const base = {
  slug: 'acme',
  name: 'Acme Corp',
  adminEmail: 'admin@acme.test',
  primaryHostname: 'acme.didacta.test',
};

function makePrisma() {
  const detail = {
    id: TENANT_ID,
    slug: base.slug,
    name: base.name,
    status: 'ACTIVE' as const,
    createdAt: new Date(),
    domains: [{ hostname: base.primaryHostname, isPrimary: true, isVerified: true }],
    _count: { users: 1 },
  };
  const tx = {
    tenant: { create: vi.fn().mockResolvedValue({ id: TENANT_ID }) },
    tenantDomain: { create: vi.fn().mockResolvedValue({}) },
    user: { create: vi.fn().mockResolvedValue({ id: 'user-admin-1' }) },
    userRole: { create: vi.fn().mockResolvedValue({}) },
    tenantSetting: { upsert: vi.fn().mockResolvedValue({}) },
  };
  return {
    tx,
    tenant: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(detail),
    },
    tenantDomain: { findUnique: vi.fn().mockResolvedValue(null) },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-tenant-admin' }) },
    modCoursesCourse: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi
      .fn()
      .mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
}

describe('alta de un aula: bienvenida y nombre de la creadora', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let reset: { requestAndSendEmail: ReturnType<typeof vi.fn> };
  let service: AdminTenantsService;

  beforeEach(async () => {
    prisma = makePrisma();
    reset = { requestAndSendEmail: vi.fn().mockResolvedValue(undefined) };
    const license = new LicenseService();
    await license.load({ allowDevBypass: true, key: 'dev-key' });
    service = new AdminTenantsService(
      ...([
        prisma,
        { record: vi.fn().mockResolvedValue(undefined) },
        reset,
        license,
        { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ] as unknown as ServiceCtor),
    );
  });

  it('manda la bienvenida de la creadora con 7 días de validez', async () => {
    await service.create(CLOUD, createTenantSchema.parse(base), 'http://x');
    expect(reset.requestAndSendEmail).toHaveBeenCalledTimes(1);
    const [args, , , opts] = reset.requestAndSendEmail.mock.calls[0]!;
    expect(args).toEqual({ email: base.adminEmail, resolvedTenantId: TENANT_ID });
    expect(opts).toEqual({ ttlMinutes: 7 * 24 * 60, kind: 'academy_owner' });
  });

  it('el nombre del alta (`adminName`) queda en su perfil, sin espacios sobrantes', async () => {
    await service.create(
      CLOUD,
      createTenantSchema.parse({ ...base, adminName: '  Lucía Ensayo ' }),
      'http://x',
    );
    expect(prisma.tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: base.adminEmail, name: 'Lucía Ensayo' }),
    });
  });

  it('CONTROL: sin `adminName` el nombre queda vacío (null), no inventado', async () => {
    await service.create(CLOUD, createTenantSchema.parse(base), 'http://x');
    expect(prisma.tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: null }),
    });
  });
});
