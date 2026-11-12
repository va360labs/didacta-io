/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Baja del creador (E6): archivar un aula desde el plano de control desconecta
 * sus cobros de plataforma (sin ventas nuevas, suscripciones a fin de
 * periodo). Sin modo plataforma no hay runtime y nada cambia.
 */

import { LicenseService } from '@didacta/license-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminTenantsService } from '../src/admin/admin-tenants.service';

type ServiceCtor = ConstructorParameters<typeof AdminTenantsService>;
const TENANT_ID = 'tenant-que-se-va';
const ACTOR = {
  kind: 'provisioning' as const,
  credentialId: '11111111-2222-3333-4444-555555555555',
};

function makePrisma(status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE') {
  const detail = {
    id: TENANT_ID,
    slug: 'se-va',
    name: 'Se va',
    status,
    createdAt: new Date(),
    domains: [],
    _count: { users: 1 },
  };
  return {
    tenant: {
      findFirst: vi.fn().mockResolvedValue(detail),
      findUnique: vi.fn().mockResolvedValue(detail),
      update: vi.fn().mockResolvedValue(detail),
    },
    modCoursesCourse: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        tenant: { update: vi.fn() },
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    ),
  };
}

describe('archivar un aula desconecta sus cobros (E6)', () => {
  let audit: { record: ReturnType<typeof vi.fn> };
  let disconnect: ReturnType<typeof vi.fn>;
  let license: LicenseService;

  async function build(opts: { status?: 'ACTIVE' | 'ARCHIVED'; payouts?: boolean } = {}) {
    return new AdminTenantsService(
      ...([
        makePrisma(opts.status),
        audit,
        { requestAndSendEmail: vi.fn() },
        license,
        { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() },
        undefined,
        undefined,
        opts.payouts === false ? undefined : { offboarding: { disconnect } },
      ] as unknown as ServiceCtor),
    );
  }

  beforeEach(async () => {
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    disconnect = vi.fn().mockResolvedValue({
      account: null,
      changed: true,
      subscriptionsScheduled: 3,
      subscriptionsFailed: 0,
    });
    license = new LicenseService();
    await license.load({ allowDevBypass: true, key: 'dev-key' });
  });

  it('ARCHIVED → desconecta con motivo «tenant_archived» y lo deja en la auditoría', async () => {
    const service = await build();
    await service.setStatus(ACTOR, TENANT_ID, 'ARCHIVED');
    expect(disconnect).toHaveBeenCalledWith(TENANT_ID, { reason: 'tenant_archived' });
    const entry = audit.record.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(entry.metadata['payoutsOffboarding']).toEqual({
      changed: true,
      subscriptionsScheduled: 3,
      subscriptionsFailed: 0,
    });
  });

  it('SUSPENDED no desconecta (suspender no es dar de baja); re-archivar tampoco repite', async () => {
    await (await build()).setStatus(ACTOR, TENANT_ID, 'SUSPENDED');
    await (await build({ status: 'ARCHIVED' })).setStatus(ACTOR, TENANT_ID, 'ARCHIVED');
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('si la desconexión falla, el aula se archiva igual y el fallo queda anotado', async () => {
    disconnect.mockRejectedValueOnce(new Error('Stripe no responde'));
    const service = await build();
    await expect(service.setStatus(ACTOR, TENANT_ID, 'ARCHIVED')).resolves.toBeTruthy();
    const entry = audit.record.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(entry.metadata['payoutsOffboarding']).toEqual({ error: 'Stripe no responde' });
  });

  it('sin modo plataforma (Community) no hay nada que desconectar', async () => {
    const service = await build({ payouts: false });
    await service.setStatus(ACTOR, TENANT_ID, 'ARCHIVED');
    expect(disconnect).not.toHaveBeenCalled();
    const entry = audit.record.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(entry.metadata).not.toHaveProperty('payoutsOffboarding');
  });
});
