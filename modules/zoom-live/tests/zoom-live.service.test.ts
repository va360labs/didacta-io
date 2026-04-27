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

function makeFakePrisma(courses: { id: string; tenantId: string }[] = []) {
  const sessions: SessionRow[] = [];

  return {
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
      async findFirst(args: { where: { tenantId: string; id: string } }) {
        return (
          sessions.find((s) => s.tenantId === args.where.tenantId && s.id === args.where.id) ?? null
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
