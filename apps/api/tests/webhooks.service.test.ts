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
import {
  KNOWN_EVENT_TYPES,
  type WebhookEnvelope,
  type WebhooksEEDispatcher,
} from '../src/webhooks/webhooks.types';

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
  public user: FakeUserRepo;

  constructor() {
    this.webhookEndpoint = new FakeEndpointRepo();
    this.webhookDeadLetter = new FakeDeadLetterRepo();
    this.user = new FakeUserRepo();
  }
}

interface FakeUserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  externalSource: string | null;
  externalId: string | null;
}

/**
 * Repo de usuarios para la resolucion de identidad del sobre. `failWith`
 * simula que el lookup revienta: el envio tiene que salir igual con
 * `learner: null`, nunca romperse.
 */
class FakeUserRepo {
  rows: FakeUserRow[] = [];
  failWith: Error | null = null;

  async findUnique(args: { where: { id: string } }): Promise<FakeUserRow | null> {
    if (this.failWith) throw this.failWith;
    return this.rows.find((r) => r.id === args.where.id) ?? null;
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

// La fila se nombra en vez de derivarla con `(typeof this.rows)[number]`:
// dentro de la firma de un método, `this` no tiene tipo y el parámetro caía
// a `any` implícito.
interface DeadLetterRow {
  id: string;
  tenantId: string;
  endpointId: string;
  eventType: string;
  payload: unknown;
  lastError: string;
  attempts: number;
  createdAt: Date;
}

class FakeDeadLetterRepo {
  rows: DeadLetterRow[] = [];

  async create(args: { data: Omit<DeadLetterRow, 'id' | 'createdAt'> }) {
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

  describe('sobre del evento (WebhookEnvelope)', () => {
    /**
     * Lee el cuerpo / las cabeceras del POST que recibio el mock de fetch.
     * El mock se tipa por su forma minima (`mock.calls`) y no con
     * `ReturnType<typeof vi.spyOn>`: ese generico fija la firma de `fetch` y
     * no encaja con el spy concreto.
     */
    interface CallSpy {
      mock: { calls: unknown[][] };
    }
    function initOf(mock: CallSpy, call: number): RequestInit {
      return mock.mock.calls[call]?.[1] as RequestInit;
    }
    function bodyOf(mock: CallSpy, call = 0): WebhookEnvelope {
      return JSON.parse(initOf(mock, call).body as string) as WebhookEnvelope;
    }
    function headersOf(mock: CallSpy, call = 0): Record<string, string> {
      return initOf(mock, call).headers as Record<string, string>;
    }

    async function svcConAlumno() {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      prisma.user.rows.push({
        id: 'user-alumna',
        tenantId: 'tenant-1',
        email: 'ana@ejemplo.com',
        name: 'Ana Ruiz',
        externalSource: 'learndash',
        externalId: '4471',
      });
      const svc = new WebhooksService(prisma as never, license);
      await svc.createEndpoint('tenant-1', {
        url: 'https://hook.example/x',
        eventTypes: ['*'],
      });
      return { svc, prisma };
    }

    it('el cuerpo lleva event, data, occurredAt, tenantId, deliveryId y learner', async () => {
      const { svc } = await svcConAlumno();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      await svc.dispatch(
        'tenant-1',
        'learning.enrollment.created',
        { enrollmentId: 'enr-1', userId: 'user-alumna', courseId: 'course-9', source: 'PURCHASE' },
        {
          actorUserId: 'user-admin',
          occurredAt: '2026-08-18T10:00:00.000Z',
          idempotencyKey: 'learning.enrollment.created:enr-1',
        },
      );

      const body = bodyOf(fetchMock);
      expect(body.event).toBe('learning.enrollment.created');
      expect(body.data).toMatchObject({ enrollmentId: 'enr-1', courseId: 'course-9' });
      expect(body.occurredAt).toBe('2026-08-18T10:00:00.000Z');
      expect(body.tenantId).toBe('tenant-1');
      expect(body.deliveryId).toMatch(/^wd_[0-9a-f]{32}$/);
      expect(body.learner).toEqual({
        id: 'user-alumna',
        email: 'ana@ejemplo.com',
        name: 'Ana Ruiz',
        externalSource: 'learndash',
        externalId: '4471',
      });
    });

    it('el sujeto es data.userId, NO el actor de los metadatos', async () => {
      const { svc, prisma } = await svcConAlumno();
      prisma.user.rows.push({
        id: 'user-admin',
        tenantId: 'tenant-1',
        email: 'admin@ejemplo.com',
        name: 'Admin',
        externalSource: null,
        externalId: null,
      });
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      // Es el caso real de enrollLearner: el admin matricula a la alumna.
      await svc.dispatch(
        'tenant-1',
        'learning.enrollment.created',
        { enrollmentId: 'enr-2', userId: 'user-alumna', courseId: 'c-1' },
        { actorUserId: 'user-admin' },
      );

      expect(bodyOf(fetchMock).learner?.email).toBe('ana@ejemplo.com');
    });

    it('sin userId en el payload cae al actor de los metadatos', async () => {
      const { svc } = await svcConAlumno();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      // subscriptions.invoice.paid no lleva userId dentro: va en los metadatos.
      await svc.dispatch(
        'tenant-1',
        'subscriptions.invoice.paid',
        { subscriptionId: 'sub-1', stripeInvoiceId: 'in_1', amount: 4900, currency: 'eur' },
        { actorUserId: 'user-alumna' },
      );

      expect(bodyOf(fetchMock).learner?.id).toBe('user-alumna');
    });

    it('usuario de otro tenant → learner null (no se filtra fuera del tenant)', async () => {
      const license = await makeLicense('community');
      const prisma = new FakePrisma();
      prisma.user.rows.push({
        id: 'user-ajeno',
        tenantId: 'tenant-OTRO',
        email: 'ajeno@ejemplo.com',
        name: 'Ajeno',
        externalSource: null,
        externalId: null,
      });
      const svc = new WebhooksService(prisma as never, license);
      await svc.createEndpoint('tenant-1', { url: 'https://hook.example/x', eventTypes: ['*'] });
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      await svc.dispatch('tenant-1', 'learning.course.completed', { userId: 'user-ajeno' });
      expect(bodyOf(fetchMock).learner).toBeNull();
    });

    it('si el lookup de identidad revienta, el webhook sale igual con learner null', async () => {
      const { svc, prisma } = await svcConAlumno();
      prisma.user.failWith = new Error('conexión perdida');
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      const results = await svc.dispatch('tenant-1', 'learning.course.completed', {
        userId: 'user-alumna',
      });
      expect(results[0]?.status).toBe('success');
      expect(bodyOf(fetchMock).learner).toBeNull();
    });

    it('evento sin persona (invoice.refunded) → learner null y se envía', async () => {
      const { svc } = await svcConAlumno();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      await svc.dispatch('tenant-1', 'subscriptions.invoice.refunded', {
        subscriptionId: 'sub-1',
        stripeInvoiceId: 'in_2',
        amountRefunded: 4900,
        currency: 'eur',
      });
      expect(bodyOf(fetchMock).learner).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('el deliveryId NO cambia entre el intento y su reintento', async () => {
      const { svc } = await svcConAlumno();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('boom', { status: 500 }));

      await svc.dispatch(
        'tenant-1',
        'learning.course.completed',
        { userId: 'user-alumna' },
        { idempotencyKey: 'learning.course.completed:enr-1' },
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(headersOf(fetchMock, 0)['X-Didacta-Delivery']).toBe(
        headersOf(fetchMock, 1)['X-Didacta-Delivery'],
      );
      // El número de intento viaja aparte, no dentro del id de entrega.
      expect(headersOf(fetchMock, 0)['X-Didacta-Attempt']).toBe('1');
      expect(headersOf(fetchMock, 1)['X-Didacta-Attempt']).toBe('2');
    });

    it('la reentrega del mismo evento trae el mismo deliveryId (deduplicable)', async () => {
      const { svc } = await svcConAlumno();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      const meta = { idempotencyKey: 'learning.course.completed:enr-7' };
      await svc.dispatch('tenant-1', 'learning.course.completed', { userId: 'user-alumna' }, meta);
      await svc.dispatch('tenant-1', 'learning.course.completed', { userId: 'user-alumna' }, meta);

      expect(bodyOf(fetchMock, 0).deliveryId).toBe(bodyOf(fetchMock, 1).deliveryId);
    });

    it('sin idempotencyKey cada envío trae un deliveryId distinto', async () => {
      const { svc } = await svcConAlumno();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      await svc.dispatch('tenant-1', 'learning.course.completed', { userId: 'user-alumna' });
      await svc.dispatch('tenant-1', 'learning.course.completed', { userId: 'user-alumna' });

      expect(bodyOf(fetchMock, 0).deliveryId).not.toBe(bodyOf(fetchMock, 1).deliveryId);
    });

    it('la cabecera de tenant viaja también en community', async () => {
      const { svc } = await svcConAlumno();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      await svc.dispatch('tenant-1', 'learning.course.completed', { userId: 'user-alumna' });
      expect(headersOf(fetchMock)['X-Didacta-Tenant']).toBe('tenant-1');
      expect(headersOf(fetchMock)['X-Didacta-Event']).toBe('learning.course.completed');
    });

    it('el path EE recibe el sobre ya resuelto', async () => {
      const license = await makeLicense('dev');
      const prisma = new FakePrisma();
      prisma.user.rows.push({
        id: 'user-alumna',
        tenantId: 'tenant-1',
        email: 'ana@ejemplo.com',
        name: 'Ana Ruiz',
        externalSource: null,
        externalId: null,
      });
      const recibidos: unknown[] = [];
      const fake: WebhooksEEDispatcher = {
        async dispatch(input) {
          recibidos.push(input.envelope);
        },
      };
      const svc = new WebhooksService(prisma as never, license, fake);
      await svc.createEndpoint('tenant-1', { url: 'https://hook.example/x', eventTypes: ['*'] });

      await svc.dispatch(
        'tenant-1',
        'billing.order.completed',
        { orderId: 'ord-1', userId: 'user-alumna' },
        { idempotencyKey: 'billing.order.completed:ord-1' },
      );

      expect(recibidos).toHaveLength(1);
      const envelope = recibidos[0] as WebhookEnvelope;
      expect(envelope.learner?.email).toBe('ana@ejemplo.com');
      expect(envelope.deliveryId).toMatch(/^wd_[0-9a-f]{32}$/);
    });
  });

  describe('catálogo de eventos', () => {
    it('no tiene entradas repetidas', () => {
      expect(new Set(KNOWN_EVENT_TYPES).size).toBe(KNOWN_EVENT_TYPES.length);
    });

    it('no incluye eventos que nadie publica', () => {
      // Los dos casos reales que hubo en la lista: `learning.lesson.completed`
      // (jamás publicado por mod.learning) y `subscriptions.membership.revoked`
      // (declarado en el manifest del módulo, sin un solo publish()).
      expect(KNOWN_EVENT_TYPES).not.toContain('learning.lesson.completed');
      expect(KNOWN_EVENT_TYPES).not.toContain('subscriptions.membership.revoked');
      expect(KNOWN_EVENT_TYPES).not.toContain('billing.subscription.created');
      expect(KNOWN_EVENT_TYPES).not.toContain('billing.subscription.cancelled');
    });

    it('cubre el ciclo de vida que necesita quien vende e integra desde fuera', () => {
      for (const evento of [
        'learning.enrollment.created',
        'learning.enrollment.paused',
        'learning.enrollment.resumed',
        'learning.enrollment.cancelled',
        'billing.order.completed',
        'billing.order.refunded',
        'billing.order.failed',
        'subscriptions.invoice.paid',
        'subscriptions.invoice.payment_failed',
        'subscriptions.subscription.canceled',
      ]) {
        expect(KNOWN_EVENT_TYPES).toContain(evento);
      }
    });

    it('un endpoint con ["*"] hace match con todo el catálogo', async () => {
      const license = await makeLicense('community');
      const svc = new WebhooksService(new FakePrisma() as never, license);
      for (const evento of KNOWN_EVENT_TYPES) {
        if (evento === '*') continue;
        expect(svc.endpointMatches(['*'], evento)).toBe(true);
      }
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
