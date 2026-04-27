import { describe, expect, it } from 'vitest';
import { ZoomLiveService } from '../src/zoom-live.service.js';
import { SessionNotFoundError, SessionAlreadyEndedError } from '../src/errors.js';
import { StubZoomApiClient } from '../src/zoom-api-client.js';

interface SessionRow {
  id: string;
  tenantId: string;
  courseId: string | null;
  topic: string;
  description: string | null;
  status: string;
  startTime: Date;
  durationMinutes: number;
  timezone: string;
  hostEmail: string;
  zoomMeetingId: string | null;
  joinUrl: string | null;
  startUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WebhookEventRow {
  id: string;
  eventId: string;
  eventType: string;
  meetingId: string | null;
  sessionId: string | null;
  tenantId: string | null;
  receivedAt: Date;
  result: string;
  errorMessage: string | null;
}

function makeFakePrisma(courses: { id: string; tenantId: string }[] = []) {
  const sessions: SessionRow[] = [];
  const webhookEvents: WebhookEventRow[] = [];

  return {
    _sessions: sessions,
    _webhookEvents: webhookEvents,
    modZoomSession: {
      async findMany(args: {
        where: { tenantId: string; courseId?: string; status?: string };
        orderBy?: unknown;
      }) {
        return sessions
          .filter((s) => s.tenantId === args.where.tenantId)
          .filter((s) => (args.where.courseId ? s.courseId === args.where.courseId : true))
          .filter((s) => (args.where.status ? s.status === args.where.status : true))
          .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
      },
      async findFirst(args: { where: { tenantId?: string; id?: string; zoomMeetingId?: string } }) {
        return (
          sessions.find((s) => {
            if (args.where.tenantId && s.tenantId !== args.where.tenantId) return false;
            if (args.where.id && s.id !== args.where.id) return false;
            if (args.where.zoomMeetingId && s.zoomMeetingId !== args.where.zoomMeetingId)
              return false;
            return true;
          }) ?? null
        );
      },
      async create(args: { data: SessionRow }) {
        const row = { ...args.data, createdAt: new Date(), updatedAt: new Date() };
        sessions.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: Partial<SessionRow> }) {
        const idx = sessions.findIndex((s) => s.id === args.where.id);
        if (idx === -1) throw new Error('not found');
        sessions[idx] = { ...sessions[idx]!, ...args.data, updatedAt: new Date() };
        return sessions[idx]!;
      },
    },
    modCoursesCourse: {
      async findFirst(args: {
        where: { id: string; tenantId: string; deletedAt: null };
        select: unknown;
      }) {
        return (
          courses.find((c) => c.id === args.where.id && c.tenantId === args.where.tenantId) ?? null
        );
      },
    },
    modZoomWebhookEvent: {
      async findUnique(args: { where: { eventId: string } }) {
        return webhookEvents.find((e) => e.eventId === args.where.eventId) ?? null;
      },
      async create(args: { data: Omit<WebhookEventRow, 'receivedAt'> }) {
        const row: WebhookEventRow = { ...args.data, receivedAt: new Date() };
        webhookEvents.push(row);
        return row;
      },
    },
  };
}

function makeCtx() {
  const events: { name: string; data: unknown }[] = [];
  return {
    eventBus: {
      async publish(evt: { name: string; data: unknown }) {
        events.push({ name: evt.name, data: evt.data });
      },
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    events,
  };
}

const TENANT = 'tenant-1';
const ACTOR = 'user-1';

describe('ZoomLiveService', () => {
  it('crea una sesión y emite evento zoom.session.created', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());

    const session = await service.create(TENANT, ACTOR, {
      topic: 'Q&A',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'host@example.com',
      timezone: 'America/Argentina/Buenos_Aires',
    });

    expect(session.tenantId).toBe(TENANT);
    expect(session.status).toBe('SCHEDULED');
    expect(session.zoomMeetingId).toBeTruthy();
    expect(session.joinUrl).toMatch(/^https:\/\/stub-zoom/);
    expect(session.startUrl).toMatch(/^https:\/\/stub-zoom/);
    expect(ctx.events).toEqual([expect.objectContaining({ name: 'zoom.session.created' })]);
  });

  it('list filtra por status', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    await service.create(TENANT, ACTOR, {
      topic: 'A',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'a@x.com',
      timezone: 'UTC',
    });
    await service.create(TENANT, ACTOR, {
      topic: 'B',
      startTime: '2026-05-16T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'b@x.com',
      timezone: 'UTC',
    });

    const all = await service.list(TENANT);
    expect(all).toHaveLength(2);

    const scheduled = await service.list(TENANT, { status: 'SCHEDULED' });
    expect(scheduled).toHaveLength(2);

    const ended = await service.list(TENANT, { status: 'ENDED' });
    expect(ended).toHaveLength(0);
  });

  it('cancel idempotente: dos cancelaciones no rompen', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'X',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });

    await service.cancel(TENANT, ACTOR, created.id);
    await service.cancel(TENANT, ACTOR, created.id); // no debería tirar
    const after = await service.get(TENANT, created.id);
    expect(after.status).toBe('CANCELLED');
  });

  it('update rechaza una sesión ya finalizada', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'X',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });
    // Manualmente metemos status ENDED.
    await prisma.modZoomSession.update({
      where: { id: created.id },
      data: { status: 'ENDED' },
    });
    await expect(
      service.update(TENANT, ACTOR, created.id, { topic: 'Otro' }),
    ).rejects.toBeInstanceOf(SessionAlreadyEndedError);
  });

  it('get rechaza sesión inexistente', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    await expect(service.get(TENANT, 'no-existe')).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('ZoomLiveService.handleWebhookEvent', () => {
  it('aplica meeting.started → status STARTED y emite zoom.session.started', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'Test',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });

    const out = await service.handleWebhookEvent({
      event_id: 'evt-1',
      event: 'meeting.started',
      payload: { object: { id: created.zoomMeetingId! } },
    });

    expect(out.result).toBe('OK');
    expect(out.sessionId).toBe(created.id);
    const after = await service.get(TENANT, created.id);
    expect(after.status).toBe('STARTED');
    expect(ctx.events.map((e) => e.name)).toContain('zoom.session.started');
  });

  it('aplica meeting.ended → status ENDED', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'Test',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });

    const out = await service.handleWebhookEvent({
      event_id: 'evt-2',
      event: 'meeting.ended',
      payload: { object: { id: created.zoomMeetingId! } },
    });

    expect(out.result).toBe('OK');
    const after = await service.get(TENANT, created.id);
    expect(after.status).toBe('ENDED');
    expect(ctx.events.map((e) => e.name)).toContain('zoom.session.ended');
  });

  it('idempotente: el mismo event_id no se aplica dos veces', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'Test',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });

    const first = await service.handleWebhookEvent({
      event_id: 'evt-dup',
      event: 'meeting.started',
      payload: { object: { id: created.zoomMeetingId! } },
    });
    const second = await service.handleWebhookEvent({
      event_id: 'evt-dup',
      event: 'meeting.started',
      payload: { object: { id: created.zoomMeetingId! } },
    });

    expect(first.result).toBe('OK');
    expect(second.result).toBe('DUPLICATE');
    // El evento se emitió una sola vez.
    const startedEvents = ctx.events.filter((e) => e.name === 'zoom.session.started');
    expect(startedEvents).toHaveLength(1);
  });

  it('IGNORED si no hay sesión local con ese meetingId', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const out = await service.handleWebhookEvent({
      event_id: 'evt-3',
      event: 'meeting.started',
      payload: { object: { id: 'meeting-desconocido' } },
    });
    expect(out.result).toBe('IGNORED');
  });

  it('IGNORED si el event_type no es started/ended', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'Test',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });
    const out = await service.handleWebhookEvent({
      event_id: 'evt-4',
      event: 'meeting.participant_joined',
      payload: { object: { id: created.zoomMeetingId! } },
    });
    expect(out.result).toBe('IGNORED');
    // Persiste el evento pero no toca status.
    const after = await service.get(TENANT, created.id);
    expect(after.status).toBe('SCHEDULED');
  });
});
