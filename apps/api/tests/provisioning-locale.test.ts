/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Aprovisionamiento con idioma: el plano de control de Didacta Cloud puede
 * mandar `locale` al crear el aula. Queda como ajuste del aula
 * (`tenant_setting academy/locale`) y la primera administradora nace en ese
 * idioma (su correo de bienvenida sale así). Sin `locale`, nada cambia.
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

describe('aprovisionamiento con idioma del aula', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: AdminTenantsService;

  beforeEach(async () => {
    prisma = makePrisma();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    const license = new LicenseService();
    await license.load({ allowDevBypass: true, key: 'dev-key' });
    service = new AdminTenantsService(
      ...([
        prisma,
        audit,
        { requestAndSendEmail: vi.fn().mockResolvedValue(undefined) },
        license,
        { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ] as unknown as ServiceCtor),
    );
  });

  it('con `locale`: ajuste del aula y administradora en ese idioma', async () => {
    const dto = createTenantSchema.parse({ ...base, locale: 'en' });
    await service.create(CLOUD, dto, 'http://x');

    expect(prisma.tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: base.adminEmail, locale: 'en-US' }),
    });
    expect(prisma.tx.tenantSetting.upsert).toHaveBeenCalledWith({
      where: {
        tenantId_moduleName_key: { tenantId: TENANT_ID, moduleName: 'academy', key: 'locale' },
      },
      create: {
        tenantId: TENANT_ID,
        moduleName: 'academy',
        key: 'locale',
        valueJson: 'en',
        isSecret: false,
        updatedById: 'user-admin-1',
      },
      update: { valueJson: 'en', updatedById: 'user-admin-1' },
    });
    expect(audit.record.mock.calls[0]?.[0].metadata.locale).toBe('en');
  });

  it('sin `locale`: ni ajuste ni idioma en la administradora (lo de siempre)', async () => {
    await service.create(CLOUD, createTenantSchema.parse(base), 'http://x');
    expect(prisma.tx.tenantSetting.upsert).not.toHaveBeenCalled();
    const data = prisma.tx.user.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty('locale');
  });

  it('el campo admite el código o un tag del idioma y lo guarda reducido', () => {
    expect(createTenantSchema.parse({ ...base, locale: 'es' }).locale).toBe('es');
    expect(createTenantSchema.parse({ ...base, locale: 'en-US' }).locale).toBe('en');
    expect(createTenantSchema.parse({ ...base, locale: ' ES_ar ' }).locale).toBe('es');
    expect(createTenantSchema.parse(base).locale).toBeUndefined();
  });

  it('un idioma sin catálogo en el aula es un 400, no un aula en otro idioma', () => {
    for (const locale of ['pt-BR', 'fr', '', 42]) {
      expect(createTenantSchema.safeParse({ ...base, locale }).success, String(locale)).toBe(false);
    }
  });
});
