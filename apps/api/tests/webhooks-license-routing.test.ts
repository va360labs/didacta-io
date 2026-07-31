/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests de routing runtime — 10º piloto License SDK.
 *
 * Demuestra que el WebhooksService observa la capability
 * `feat:api.webhooks.high_throughput` SIN reinicio:
 *
 *   1. Capability OFF → dispatch usa el path naive (fetch).
 *   2. Recargo la licencia con dev bypass → dispatch ahora delega al EE.
 *   3. Volver a OFF → dispatch vuelve a naive.
 *
 * El service no se reconstruye entre transiciones — esto es lo que prueba
 * que el gating es runtime y no de boot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import type { WebhooksEEDispatcher } from '../src/webhooks/webhooks.types';

class FakePrisma {
  rows: Array<{
    id: string;
    tenantId: string;
    url: string;
    secret: string;
    eventTypes: string[];
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  webhookEndpoint = {
    findMany: async ({ where }: { where: { tenantId: string; active?: boolean } }) =>
      this.rows.filter(
        (r) =>
          r.tenantId === where.tenantId &&
          (where.active === undefined || r.active === where.active),
      ),
    findFirst: async ({ where }: { where: { id?: string; tenantId?: string; url?: string } }) =>
      this.rows.find(
        (r) =>
          (!where.id || r.id === where.id) &&
          (!where.tenantId || r.tenantId === where.tenantId) &&
          (!where.url || r.url === where.url),
      ) ?? null,
    count: async ({ where }: { where: { tenantId: string } }) =>
      this.rows.filter((r) => r.tenantId === where.tenantId).length,
    create: async ({
      data,
    }: {
      data: {
        tenantId: string;
        url: string;
        secret: string;
        eventTypes: string[];
        active: boolean;
      };
    }) => {
      const row = {
        id: `wh-${this.rows.length + 1}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.rows.push(row);
      return row;
    },
    update: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Webhooks routing runtime · license OFF → ON → OFF', () => {
  it('mismo service: capability OFF=naive, ON=EE, OFF=naive', async () => {
    const license = new LicenseService();
    await license.load({ key: null });
    const prisma = new FakePrisma();
    const eeCalls: unknown[] = [];
    const eeDispatcher: WebhooksEEDispatcher = {
      async dispatch(input) {
        eeCalls.push(input);
      },
    };
    const svc = new WebhooksService(prisma as never, license, eeDispatcher);

    // Endpoint común a todos los pasos.
    await svc.createEndpoint('tenant-1', {
      url: 'https://hook.example/x',
      eventTypes: ['*'],
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    // 1) capability OFF → naive.
    expect(svc.getCurrentTier()).toBe('community');
    let res = await svc.dispatch('tenant-1', 'learning.course.completed', { i: 1 });
    expect(res).toHaveLength(1);
    expect(eeCalls).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2) capability ON → EE delegate.
    await license.load({ allowDevBypass: true, key: 'dev' });
    expect(svc.getCurrentTier()).toBe('enterprise');
    res = await svc.dispatch('tenant-1', 'learning.course.completed', { i: 2 });
    expect(res).toEqual([]);
    expect(eeCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // NO incrementa

    // 3) capability OFF de nuevo → naive.
    await license.load({ key: null });
    expect(svc.getCurrentTier()).toBe('community');
    res = await svc.dispatch('tenant-1', 'learning.course.completed', { i: 3 });
    expect(res).toHaveLength(1);
    expect(eeCalls).toHaveLength(1); // NO incrementa
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
