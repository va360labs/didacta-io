/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del WebhooksService — 10º piloto License SDK
 * (capability `feat:api.webhooks.high_throughput`).
 *
 * Cobertura mínima:
 *   - getCurrentTier reacciona a la licencia.
 *   - Límite community: 1 endpoint por tenant, 3 eventos por endpoint.
 *   - Límite enterprise: 20 endpoints, eventos ilimitados.
 *   - URL duplicada por tenant rechazada.
 *   - createEndpoint genera secret si no se provee, lo devuelve one-shot,
 *     getEndpoint solo devuelve secretMasked.
 *   - updateEndpoint puede rotar el secret y devolverlo.
 *   - deleteEndpoint idempotente.
 *   - endpointMatches: '*', exact, prefix wildcard.
 *   - dispatch naive con éxito 200 → status='success', attempts=1.
 *   - dispatch naive con 500 fail → 1 reintento, status='failure', attempts=2.
 *   - dispatch enterprise + dispatcher inyectado → delega.
 *   - dispatch enterprise + dispatcher inyectado pero falla enqueue → fallback naive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import {
  WebhookDuplicateUrlError,
  WebhookLimitExceededError,
  WebhooksService,
} from '../src/webhooks/webhooks.service';
import type { WebhooksEEDispatcher } from '../src/webhooks/webhooks.types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  eventTypes: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  public webhookEndpoint: FakeEndpointRepo;
  public webhookDeadLetter: FakeDeadLetterRepo;

  constructor() {
    this.webhookEndpoint = new FakeEndpointRepo();
    this.webhookDeadLetter = new FakeDeadLetterRepo();
  }
}

class FakeEndpointRepo {
  rows: FakeRow[] = [];
  private counter = 0;

  async findMany(args: { where: { tenantId: string; active?: boolean }; orderBy?: unknown }) {
    return this.rows.filter(
      (r) =>
        r.tenantId === args.where.tenantId &&
        (args.where.active === undefined || r.active === args.where.active),
    );
  }

  async findFirst(args: {
    where: {
      id?: string;
      tenantId?: string;
      url?: string;
      NOT?: { id?: string };
    };
    select?: { id: boolean };
  }) {
    const w = args.where;
    return (
      this.rows.find(
        (r) =>
          (!w.id || r.id === w.id) &&
          (!w.tenantId || r.tenantId === w.tenantId) &&
          (!w.url || r.url === w.url) &&
          (!w.NOT?.id || r.id !== w.NOT.id),
      ) ?? null
    );
  }

  async count(args: { where: { tenantId: string } }) {
    return this.rows.filter((r) => r.tenantId === args.where.tenantId).length;
  }

  async create(args: {
    data: {
      tenantId: string;
      url: string;
      secret: string;
      eventTypes: string[];
      active: boolean;
    };
  }): Promise<FakeRow> {
    const row: FakeRow = {
      id: `wh-${++this.counter}`,
      tenantId: args.data.tenantId,
      url: args.data.url,
      secret: args.data.secret,
      eventTypes: args.data.eventTypes,
      active: args.data.active,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async update(args: {
    where: { id: string };
    data: Partial<Pick<FakeRow, 'url' | 'eventTypes' | 'secret' | 'active'>>;
  }) {
    const row = this.rows.find((r) => r.id === args.where.id);
    if (!row) throw new Error('Row not found');
    if (args.data.url !== undefined) row.url = args.data.url;
    if (args.data.eventTypes !== undefined) row.eventTypes = args.data.eventTypes;
    if (args.data.secret !== undefined) row.secret = args.data.secret;
    if (args.data.active !== undefined) row.active = args.data.active;
    row.updatedAt = new Date();
    return row;
  }

  async deleteMany(args: { where: { id: string; tenantId: string } }) {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(r.id === args.where.id && r.tenantId === args.where.tenantId),
    );
    return { count: before - this.rows.length };
  }
}

class FakeDeadLetterRepo {
  rows: Array<{
    id: string;
    tenantId: string;
    endpointId: string;
    eventType: string;
    payload: unknown;
    lastError: string;
    attempts: number;
    createdAt: Date;
  }> = [];

  async create(args: { data: Omit<(typeof this.rows)[number], 'id' | 'createdAt'> }) {
    const row = {
      id: `dl-${this.rows.length + 1}`,
      ...args.data,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }
}

async function makeLicense(state: 'community' | 'dev'): Promise<LicenseService> {
  const license = new LicenseService();
  if (state === 'dev') {
    await license.load({ allowDevBypass: true, key: 'dev' });
  } else {
    await license.load({ key: null });
  }
  return license;
}

const ENV_KEYS = [
  'WEBHOOKS_TIMEOUT_MS',
  'WEBHOOKS_COMMUNITY_MAX_ENDPOINTS',
  'WEBHOOKS_COMMUNITY_MAX_EVENTS',
  'WEBHOOKS_ENTERPRISE_MAX_ENDPOINTS',
] as const;
let envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhooksService · gate feat:api.webhooks.high_throughput', () => {
  describe('tier resolution', () => {
    it('sin licencia → tier community', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      expect(svc.getCurrentTier()).toBe('community');
    });

    it('con dev bypass → tier enterprise', async () => {
      const license = await makeLicense('dev');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      expect(svc.getCurrentTier()).toBe('enterprise');
    });

    it('cambio de licencia en runtime cambia el tier', async () => {
      const license = new LicenseService();
      await license.load({ key: null });
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      expect(svc.getCurrentTier()).toBe('community');
      await license.load({ allowDevBypass: true, key: 'dev' });
      expect(svc.getCurrentTier()).toBe('enterprise');
    });
  });

  describe('CRUD community (límite 1/3)', () => {
    it('createEndpoint genera secret si no se provee', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);

      const created = await svc.createEndpoint('tenant-1', {
        url: 'https://example.com/hook',
        eventTypes: ['learning.course.completed'],
      });
      expect(created.secret).toMatch(/^whsec_/);
      expect(created.secret.length).toBeGreaterThan(20);
      expect(created.secretMasked.endsWith(created.secret.slice(-4))).toBe(true);
      expect(prisma.webhookEndpoint.rows).toHaveLength(1);
    });

    it('createEndpoint con 2do endpoint en community → WebhookLimitExceededError', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);

      await svc.createEndpoint('tenant-1', {
        url: 'https://a.com/hook',
        eventTypes: ['*'],
      });
      await expect(
        svc.createEndpoint('tenant-1', {
          url: 'https://b.com/hook',
          eventTypes: ['*'],
        }),
      ).rejects.toBeInstanceOf(WebhookLimitExceededError);
    });

    it('createEndpoint con 4 eventos en community → WebhookLimitExceededError', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);

      await expect(
        svc.createEndpoint('tenant-1', {
          url: 'https://a.com/hook',
          eventTypes: ['e1', 'e2', 'e3', 'e4'],
        }),
      ).rejects.toBeInstanceOf(WebhookLimitExceededError);
    });

    it('createEndpoint con event "*" único en community sí está permitido', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);

      const created = await svc.createEndpoint('tenant-1', {
        url: 'https://a.com/hook',
        eventTypes: ['*'],
      });
      expect(created.eventTypes).toEqual(['*']);
    });

    it('URL duplicada por tenant → WebhookDuplicateUrlError', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      // Aumentamos límite para llegar al check de URL.
      process.env['WEBHOOKS_COMMUNITY_MAX_ENDPOINTS'] = '5';
      const svc = new WebhooksService(prisma as never, license);

      await svc.createEndpoint('tenant-1', {
        url: 'https://a.com/hook',
        eventTypes: ['*'],
      });
      await expect(
        svc.createEndpoint('tenant-1', {
          url: 'https://a.com/hook',
          eventTypes: ['*'],
        }),
      ).rejects.toBeInstanceOf(WebhookDuplicateUrlError);
    });

    it('mismo URL pero tenant distinto: OK', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);

      await svc.createEndpoint('tenant-A', {
        url: 'https://a.com/hook',
        eventTypes: ['*'],
      });
      await expect(
        svc.createEndpoint('tenant-B', {
          url: 'https://a.com/hook',
          eventTypes: ['*'],
        }),
      ).resolves.toBeDefined();
    });

    it('deleteEndpoint idempotente', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      await expect(svc.deleteEndpoint('tenant-1', 'no-existe')).resolves.toBeUndefined();
    });
  });

  describe('CRUD enterprise (límite 20, eventos ilimitados)', () => {
    it('createEndpoint con 5 eventos en EE: OK', async () => {
      const license = await makeLicense('dev');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      const created = await svc.createEndpoint('tenant-1', {
        url: 'https://a.com/hook',
        eventTypes: ['e1', 'e2', 'e3', 'e4', 'e5'],
      });
      expect(created.eventTypes).toHaveLength(5);
    });

    it('crear 2do endpoint en EE: OK (community lo prohibiría)', async () => {
      const license = await makeLicense('dev');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      await svc.createEndpoint('tenant-1', { url: 'https://a.com/hook', eventTypes: ['*'] });
      await expect(
        svc.createEndpoint('tenant-1', { url: 'https://b.com/hook', eventTypes: ['*'] }),
      ).resolves.toBeDefined();
    });
  });

  describe('endpointMatches', () => {
    it('"*" matchea cualquier evento', async () => {
      const license = await makeLicense('community');
      const svc = new WebhooksService(new FakePrisma() as never, license);
      expect(svc.endpointMatches(['*'], 'learning.course.completed')).toBe(true);
    });
    it('exact match', async () => {
      const license = await makeLicense('community');
      const svc = new WebhooksService(new FakePrisma() as never, license);
      expect(svc.endpointMatches(['learning.course.completed'], 'learning.course.completed')).toBe(
        true,
      );
      expect(
        svc.endpointMatches(['learning.course.completed'], 'learning.enrollment.created'),
      ).toBe(false);
    });
    it('prefix wildcard "learning.*"', async () => {
      const license = await makeLicense('community');
      const svc = new WebhooksService(new FakePrisma() as never, license);
      expect(svc.endpointMatches(['learning.*'], 'learning.course.completed')).toBe(true);
      expect(svc.endpointMatches(['learning.*'], 'community.post.created')).toBe(false);
    });
    it('lista vacía no hace match', async () => {
      const license = await makeLicense('community');
      const svc = new WebhooksService(new FakePrisma() as never, license);
      expect(svc.endpointMatches([], 'whatever')).toBe(false);
    });
  });

  describe('dispatch naive (community)', () => {
    it('200 OK → success en primer intento', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      await svc.createEndpoint('tenant-1', {
        url: 'https://hook.example/x',
        eventTypes: ['learning.course.completed'],
      });

      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      const results = await svc.dispatch('tenant-1', 'learning.course.completed', { ok: 1 });
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe('success');
      expect(results[0]?.attempts).toBe(1);
      expect(results[0]?.httpStatus).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('500 → 1 reintento → failure con attempts=2', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      await svc.createEndpoint('tenant-1', {
        url: 'https://hook.example/x',
        eventTypes: ['*'],
      });

      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('boom', { status: 500 }));

      const results = await svc.dispatch('tenant-1', 'whatever', {});
      expect(results[0]?.status).toBe('failure');
      expect(results[0]?.attempts).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('endpoint inactive: NO dispara', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      const created = await svc.createEndpoint('tenant-1', {
        url: 'https://hook.example/x',
        eventTypes: ['*'],
      });
      await svc.updateEndpoint('tenant-1', created.id, { active: false });

      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const results = await svc.dispatch('tenant-1', 'learning.course.completed', {});
      expect(results).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('eventType no suscrito: NO dispara', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      await svc.createEndpoint('tenant-1', {
        url: 'https://hook.example/x',
        eventTypes: ['learning.course.completed'],
      });

      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const results = await svc.dispatch('tenant-1', 'community.post.created', {});
      expect(results).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('updateEndpoint — rotación de secret', () => {
    it('si dto.secret presente, lo devuelve one-shot', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      const created = await svc.createEndpoint('tenant-1', {
        url: 'https://a.com/hook',
        eventTypes: ['*'],
      });
      const newSecret = 'whsec_rotated_secret_aaaaaaaaaaaa';
      const updated = await svc.updateEndpoint('tenant-1', created.id, { secret: newSecret });
      expect((updated as { secret?: string }).secret).toBe(newSecret);
    });

    it('si dto.secret ausente, NO lo devuelve', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      const created = await svc.createEndpoint('tenant-1', {
        url: 'https://a.com/hook',
        eventTypes: ['*'],
      });
      const updated = await svc.updateEndpoint('tenant-1', created.id, { active: false });
      expect((updated as { secret?: string }).secret).toBeUndefined();
    });
  });

  describe('aislamiento por tenant', () => {
    it('tenant A no ve endpoints de tenant B', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      await svc.createEndpoint('tenant-A', { url: 'https://a.com', eventTypes: ['*'] });
      await svc.createEndpoint('tenant-B', { url: 'https://b.com', eventTypes: ['*'] });

      const listA = await svc.listEndpoints('tenant-A');
      expect(listA).toHaveLength(1);
      expect(listA[0]?.url).toBe('https://a.com');
    });
  });

  describe('getInfo', () => {
    it('community devuelve límites 1/3 y comparativa enterprise 20/0', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      const svc = new WebhooksService(prisma as never, license);
      const info = svc.getInfo();
      expect(info.tier).toBe('community');
      expect(info.limits.maxEndpoints).toBe(1);
      expect(info.limits.maxEventsPerEndpoint).toBe(3);
      expect(info.community.maxEndpoints).toBe(1);
      expect(info.enterprise.maxEndpoints).toBe(20);
      expect(info.knownEventTypes).toContain('learning.course.completed');
    });
  });
});

// ---------------------------------------------------------------------------
// Routing entre tier community y dispatcher EE.
// ---------------------------------------------------------------------------

describe('WebhooksService routing → tier dinámico', () => {
  function makeFakeDispatcher(): WebhooksEEDispatcher & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async dispatch(input) {
        calls.push(input);
      },
    };
  }

  it('tier=community: ignora el dispatcher EE inyectado y usa naive', async () => {
    const license = await makeLicense('community');
    const prisma = new FakePrisma();
    const eeDispatcher = makeFakeDispatcher();
    const svc = new WebhooksService(prisma as never, license, eeDispatcher);

    await svc.createEndpoint('tenant-1', {
      url: 'https://a.com/hook',
      eventTypes: ['*'],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const results = await svc.dispatch('tenant-1', 'learning.course.completed', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('success');
    expect(eeDispatcher.calls).toHaveLength(0);
  });

  it('tier=enterprise + dispatcher inyectado: delega y NO hace fetch', async () => {
    const license = await makeLicense('dev');
    const prisma = new FakePrisma();
    const eeDispatcher = makeFakeDispatcher();
    const svc = new WebhooksService(prisma as never, license, eeDispatcher);

    await svc.createEndpoint('tenant-1', {
      url: 'https://a.com/hook',
      eventTypes: ['*'],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const results = await svc.dispatch('tenant-1', 'learning.course.completed', { x: 1 });
    expect(results).toEqual([]);
    expect(eeDispatcher.calls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tier=enterprise + dispatcher lanza → fallback naive sin perder evento', async () => {
    const license = await makeLicense('dev');
    const prisma = new FakePrisma();
    const eeDispatcher: WebhooksEEDispatcher = {
      async dispatch() {
        throw new Error('Redis caído');
      },
    };
    const svc = new WebhooksService(prisma as never, license, eeDispatcher);

    await svc.createEndpoint('tenant-1', {
      url: 'https://a.com/hook',
      eventTypes: ['*'],
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await svc.dispatch('tenant-1', 'learning.course.completed', {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('tier=enterprise sin dispatcher inyectado: cae a naive', async () => {
    const license = await makeLicense('dev');
    const prisma = new FakePrisma();
    const svc = new WebhooksService(prisma as never, license);

    await svc.createEndpoint('tenant-1', {
      url: 'https://a.com/hook',
      eventTypes: ['*'],
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const results = await svc.dispatch('tenant-1', 'learning.course.completed', {});
    expect(results).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
