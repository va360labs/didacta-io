import { describe, expect, it } from 'vitest';
import { ZoomLiveService } from '../src/zoom-live.service.js';
import {
  SessionNotFoundError,
  SessionAlreadyEndedError,
  SessionNotOpenForRegistrationError,
} from '../src/errors.js';
import { StubZoomApiClient } from '../src/zoom-api-client.js';

interface SessionRow {
  id: string;
  tenantId: string;
  courseId: string | null;
  lessonId: string | null;
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
  recordingUrl: string | null;
  recordingDurationMinutes: number | null;
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

interface RegistrationRow {
  id: string;
  tenantId: string;
  sessionId: string;
  userId: string;
  registeredAt: Date;
}

interface FakeUser {
  id: string;
  tenantId: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

function makeFakePrisma(courses: { id: string; tenantId: string }[] = [], users: FakeUser[] = []) {
  const sessions: SessionRow[] = [];
  const webhookEvents: WebhookEventRow[] = [];
  const registrations: RegistrationRow[] = [];

  // Simula el `include: { _count: { select: { registrations: true } } }` que
  // usa el service real. Lo adjuntamos siempre: es inocuo para los callers
  // que no lo piden.
  const withCount = (row: SessionRow) => ({
    ...row,
    _count: { registrations: registrations.filter((r) => r.sessionId === row.id).length },
  });

  return {
    _sessions: sessions,
    _webhookEvents: webhookEvents,
    _registrations: registrations,
    modZoomSession: {
      async findMany(args: {
        where: {
          tenantId: string;
          courseId?: string;
          status?: string;
          startTime?: { gte?: Date; lte?: Date };
        };
        orderBy?: unknown;
      }) {
        return sessions
          .filter((s) => s.tenantId === args.where.tenantId)
          .filter((s) => (args.where.courseId ? s.courseId === args.where.courseId : true))
          .filter((s) => (args.where.status ? s.status === args.where.status : true))
          .filter((s) =>
            args.where.startTime?.gte ? s.startTime >= args.where.startTime.gte : true,
          )
          .filter((s) =>
            args.where.startTime?.lte ? s.startTime <= args.where.startTime.lte : true,
          )
          .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
          .map(withCount);
      },
      async findFirst(args: { where: { tenantId?: string; id?: string; zoomMeetingId?: string } }) {
        const found = sessions.find((s) => {
          if (args.where.tenantId && s.tenantId !== args.where.tenantId) return false;
          if (args.where.id && s.id !== args.where.id) return false;
          if (args.where.zoomMeetingId && s.zoomMeetingId !== args.where.zoomMeetingId)
            return false;
          return true;
        });
        return found ? withCount(found) : null;
      },
      async create(args: {
        data: Partial<SessionRow> & Pick<SessionRow, 'id' | 'tenantId' | 'topic'>;
      }) {
        const row: SessionRow = {
          lessonId: null,
          courseId: null,
          description: null,
          recordingUrl: null,
          recordingDurationMinutes: null,
          status: 'SCHEDULED',
          startTime: new Date(),
          durationMinutes: 60,
          timezone: 'UTC',
          hostEmail: '',
          zoomMeetingId: null,
          joinUrl: null,
          startUrl: null,
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as SessionRow;
        sessions.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: Partial<SessionRow> }) {
        const idx = sessions.findIndex((s) => s.id === args.where.id);
        if (idx === -1) throw new Error('not found');
        sessions[idx] = { ...sessions[idx]!, ...args.data, updatedAt: new Date() };
        return withCount(sessions[idx]!);
      },
      async updateMany(args: {
        where: { id: string; tenantId?: string; status?: { notIn: string[] } };
        data: Partial<SessionRow>;
      }) {
        let count = 0;
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i]!;
          if (s.id !== args.where.id) continue;
          if (args.where.tenantId && s.tenantId !== args.where.tenantId) continue;
          if (args.where.status?.notIn && args.where.status.notIn.includes(s.status)) continue;
          sessions[i] = { ...s, ...args.data, updatedAt: new Date() };
          count++;
        }
        return { count };
      },
    },
    modZoomSessionRegistration: {
      async findUnique(args: {
        where: { mod_zoom_session_registration_unique: { sessionId: string; userId: string } };
      }) {
        const { sessionId, userId } = args.where.mod_zoom_session_registration_unique;
        return registrations.find((r) => r.sessionId === sessionId && r.userId === userId) ?? null;
      },
      async findMany(args: {
        where: {
          tenantId: string;
          userId?: string;
          sessionId?: string | { in: string[] };
        };
        select?: unknown;
        orderBy?: unknown;
      }) {
        return registrations
          .filter((r) => r.tenantId === args.where.tenantId)
          .filter((r) => (args.where.userId ? r.userId === args.where.userId : true))
          .filter((r) => {
            const sid = args.where.sessionId;
            if (!sid) return true;
            if (typeof sid === 'string') return r.sessionId === sid;
            return sid.in.includes(r.sessionId);
          })
          .sort((a, b) => a.registeredAt.getTime() - b.registeredAt.getTime());
      },
      async create(args: { data: Omit<RegistrationRow, 'registeredAt'> }) {
        const dup = registrations.some(
          (r) => r.sessionId === args.data.sessionId && r.userId === args.data.userId,
        );
        if (dup) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row: RegistrationRow = { ...args.data, registeredAt: new Date() };
        registrations.push(row);
        return row;
      },
      async deleteMany(args: { where: { tenantId: string; sessionId: string; userId: string } }) {
        const before = registrations.length;
        for (let i = registrations.length - 1; i >= 0; i--) {
          const r = registrations[i]!;
          if (
            r.tenantId === args.where.tenantId &&
            r.sessionId === args.where.sessionId &&
            r.userId === args.where.userId
          ) {
            registrations.splice(i, 1);
          }
        }
        return { count: before - registrations.length };
      },
    },
    user: {
      async findMany(args: {
        where: { tenantId: string; id: { in: string[] } };
        select?: unknown;
      }) {
        return users
          .filter((u) => u.tenantId === args.where.tenantId)
          .filter((u) => args.where.id.in.includes(u.id));
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
        // En CI los inserts caen dentro del mismo milisegundo y un sort
        // por receivedAt no es determinístico. Garantizamos +1ms por
        // cada insert para reproducir el orden estable que Prisma+
        // PostgreSQL emiten via `orderBy: [receivedAt, id]`.
        const lastTs = webhookEvents.length
          ? webhookEvents[webhookEvents.length - 1]!.receivedAt.getTime()
          : Date.now();
        const row: WebhookEventRow = { ...args.data, receivedAt: new Date(lastTs + 1) };
        webhookEvents.push(row);
        return row;
      },
      async findMany(args: {
        where: { tenantId?: string; eventType?: string; result?: string };
        orderBy?: unknown;
        skip?: number;
        take?: number;
      }) {
        const filtered = webhookEvents
          .filter((e) => (args.where.tenantId ? e.tenantId === args.where.tenantId : true))
          .filter((e) => (args.where.eventType ? e.eventType === args.where.eventType : true))
          .filter((e) => (args.where.result ? e.result === args.where.result : true))
          .sort((a, b) => {
            const dt = b.receivedAt.getTime() - a.receivedAt.getTime();
            if (dt !== 0) return dt;
            // Tiebreak por id DESC, igual que el service real.
            return b.id.localeCompare(a.id);
          });
        const skip = args.skip ?? 0;
        const take = args.take ?? filtered.length;
        return filtered.slice(skip, skip + take);
      },
      async count(args: { where: { tenantId?: string; eventType?: string; result?: string } }) {
        return webhookEvents
          .filter((e) => (args.where.tenantId ? e.tenantId === args.where.tenantId : true))
          .filter((e) => (args.where.eventType ? e.eventType === args.where.eventType : true))
          .filter((e) => (args.where.result ? e.result === args.where.result : true)).length;
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

  it('recording.completed → guarda recordingUrl + recordingDurationMinutes y emite zoom.session.recording_ready', async () => {
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
      event_id: 'evt-rec-1',
      event: 'recording.completed',
      payload: {
        object: {
          id: created.zoomMeetingId!,
          share_url: 'https://zoom.us/rec/share/abc-XYZ',
          duration: 47,
        },
      },
    });

    expect(out.result).toBe('OK');
    expect(out.sessionId).toBe(created.id);
    // getForHost: la vista staff no gatea recordingUrl (ADR-017).
    const after = await service.getForHost(TENANT, created.id);
    expect(after.recordingUrl).toBe('https://zoom.us/rec/share/abc-XYZ');
    expect(after.recordingDurationMinutes).toBe(47);
    // No cambia el status: meeting.ended ya pudo haberlo dejado en ENDED.
    expect(after.status).toBe('SCHEDULED');
    expect(ctx.events.map((e) => e.name)).toContain('zoom.session.recording_ready');
  });

  it('recording.completed sin share_url → IGNORED y sesión sin grabación', async () => {
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
      event_id: 'evt-rec-2',
      event: 'recording.completed',
      payload: { object: { id: created.zoomMeetingId! } },
    });

    expect(out.result).toBe('IGNORED');
    const after = await service.getForHost(TENANT, created.id);
    expect(after.recordingUrl).toBeNull();
    expect(after.recordingDurationMinutes).toBeNull();
  });
});

describe('ZoomLiveService · inscripciones y gating (ADR-017)', () => {
  const ALUMNO = 'alumno-1';

  async function makeSession(service: ZoomLiveService) {
    return service.create(TENANT, ACTOR, {
      topic: 'Clase en directo',
      startTime: '2026-08-01T10:00:00+02:00',
      durationMinutes: 60,
      hostEmail: 'host@x.com',
      timezone: 'Europe/Madrid',
    });
  }

  it('register crea la inscripción, emite el evento y desbloquea joinUrl', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);

    const view = await service.register(TENANT, ALUMNO, created.id);

    expect(view.isRegistered).toBe(true);
    expect(view.registeredCount).toBe(1);
    expect(view.joinUrl).toMatch(/^https:\/\/stub-zoom/);
    const regEvents = ctx.events.filter((e) => e.name === 'zoom.session.registration.created');
    expect(regEvents).toHaveLength(1);
    expect(regEvents[0]!.data).toMatchObject({ sessionId: created.id, userId: ALUMNO });
  });

  it('register es idempotente: no duplica fila ni re-emite el evento', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);

    await service.register(TENANT, ALUMNO, created.id);
    const second = await service.register(TENANT, ALUMNO, created.id);

    expect(second.registeredCount).toBe(1);
    expect(ctx.events.filter((e) => e.name === 'zoom.session.registration.created')).toHaveLength(
      1,
    );
  });

  it('register rechaza sesiones ENDED y CANCELLED', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await prisma.modZoomSession.update({ where: { id: created.id }, data: { status: 'ENDED' } });
    await expect(service.register(TENANT, ALUMNO, created.id)).rejects.toBeInstanceOf(
      SessionNotOpenForRegistrationError,
    );

    const otra = await makeSession(service);
    await service.cancel(TENANT, ACTOR, otra.id);
    await expect(service.register(TENANT, ALUMNO, otra.id)).rejects.toBeInstanceOf(
      SessionNotOpenForRegistrationError,
    );
  });

  it('gating: sin inscripción, joinUrl y recordingUrl van NULL; staff sí los ve', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await prisma.modZoomSession.update({
      where: { id: created.id },
      data: { recordingUrl: 'https://zoom.us/rec/share/xyz' },
    });

    // Alumno NO inscrito.
    const alumnoView = await service.get(TENANT, created.id, { userId: 'otro', isStaff: false });
    expect(alumnoView.joinUrl).toBeNull();
    expect(alumnoView.recordingUrl).toBeNull();
    expect(alumnoView.isRegistered).toBe(false);

    // Sin viewer (llamada interna) tampoco expone.
    const anon = await service.get(TENANT, created.id);
    expect(anon.joinUrl).toBeNull();

    // Staff ve todo.
    const staffView = await service.get(TENANT, created.id, { userId: ACTOR, isStaff: true });
    expect(staffView.joinUrl).toMatch(/^https:\/\/stub-zoom/);
    expect(staffView.recordingUrl).toBe('https://zoom.us/rec/share/xyz');

    // También en list().
    const [inList] = await service.list(TENANT, {}, { userId: 'otro', isStaff: false });
    expect(inList!.joinUrl).toBeNull();
  });

  it('gating: el inscrito ve joinUrl y recordingUrl en get y list', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await service.register(TENANT, ALUMNO, created.id);
    await prisma.modZoomSession.update({
      where: { id: created.id },
      data: { recordingUrl: 'https://zoom.us/rec/share/xyz' },
    });

    const view = await service.get(TENANT, created.id, { userId: ALUMNO, isStaff: false });
    expect(view.joinUrl).toMatch(/^https:\/\/stub-zoom/);
    expect(view.recordingUrl).toBe('https://zoom.us/rec/share/xyz');
    expect(view.isRegistered).toBe(true);

    const [inList] = await service.list(TENANT, {}, { userId: ALUMNO, isStaff: false });
    expect(inList!.joinUrl).toMatch(/^https:\/\/stub-zoom/);
    expect(inList!.isRegistered).toBe(true);
  });

  it('unregister borra la inscripción, re-gatea joinUrl y es idempotente', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await service.register(TENANT, ALUMNO, created.id);

    const first = await service.unregister(TENANT, ALUMNO, created.id);
    expect(first.unregistered).toBe(true);
    const view = await service.get(TENANT, created.id, { userId: ALUMNO, isStaff: false });
    expect(view.isRegistered).toBe(false);
    expect(view.joinUrl).toBeNull();
    expect(view.registeredCount).toBe(0);

    const second = await service.unregister(TENANT, ALUMNO, created.id);
    expect(second.unregistered).toBe(false);
    expect(ctx.events.filter((e) => e.name === 'zoom.session.registration.cancelled')).toHaveLength(
      1,
    );
  });

  it('listRegistrations devuelve el roster con nombre/email del user core', async () => {
    const prisma = makeFakePrisma(
      [],
      [
        { id: 'u-1', tenantId: TENANT, name: 'Uno', email: 'uno@x.com', avatarUrl: null },
        { id: 'u-2', tenantId: TENANT, name: null, email: 'dos@x.com', avatarUrl: 'https://a/2' },
      ],
    );
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await service.register(TENANT, 'u-1', created.id);
    await service.register(TENANT, 'u-2', created.id);

    const roster = await service.listRegistrations(TENANT, created.id);
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({ userId: 'u-1', name: 'Uno', email: 'uno@x.com' });
    expect(roster[1]).toMatchObject({ userId: 'u-2', name: null, email: 'dos@x.com' });

    await expect(service.listRegistrations(TENANT, 'no-existe')).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('dos cancel() concurrentes publican zoom.session.cancelled UNA sola vez', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await service.register(TENANT, ALUMNO, created.id);

    // Doble click del admin: ambos requests leen SCHEDULED antes de que
    // ninguno escriba. Solo el que gana el updateMany atómico publica.
    await Promise.all([
      service.cancel(TENANT, ACTOR, created.id),
      service.cancel(TENANT, ACTOR, created.id),
    ]);

    expect(ctx.events.filter((e) => e.name === 'zoom.session.cancelled')).toHaveLength(1);
    const after = await service.get(TENANT, created.id);
    expect(after.status).toBe('CANCELLED');
  });

  it('register aísla por tenant: no se puede inscribir a una sesión de otro tenant', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);

    await expect(service.register('tenant-otro', ALUMNO, created.id)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    await expect(service.listRegistrations('tenant-otro', created.id)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    await expect(service.unregister('tenant-otro', ALUMNO, created.id)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('meeting.started reentregado NO resucita una sesión CANCELLED', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await service.cancel(TENANT, ACTOR, created.id);

    const out = await service.handleWebhookEvent({
      event_id: 'evt-started-tras-cancel',
      event: 'meeting.started',
      payload: { object: { id: created.zoomMeetingId! } },
    });

    expect(out.result).toBe('IGNORED');
    const after = await service.get(TENANT, created.id);
    expect(after.status).toBe('CANCELLED');
    expect(ctx.events.map((e) => e.name)).not.toContain('zoom.session.started');
  });

  it('cancel incluye registeredUserIds en el evento para el bridge de avisos', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await service.register(TENANT, 'u-1', created.id);
    await service.register(TENANT, 'u-2', created.id);

    await service.cancel(TENANT, ACTOR, created.id);

    const cancelled = ctx.events.find((e) => e.name === 'zoom.session.cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled!.data).toMatchObject({ sessionId: created.id, topic: 'Clase en directo' });
    expect((cancelled!.data as { registeredUserIds: string[] }).registeredUserIds.sort()).toEqual([
      'u-1',
      'u-2',
    ]);
  });
});

describe('ZoomLiveService.listWebhookEvents', () => {
  it('pagina y filtra por eventType y result', async () => {
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

    // Genero 3 eventos: meeting.started (OK), meeting.ended (OK), participant_joined (IGNORED).
    await service.handleWebhookEvent({
      event_id: 'a',
      event: 'meeting.started',
      payload: { object: { id: created.zoomMeetingId! } },
    });
    await service.handleWebhookEvent({
      event_id: 'b',
      event: 'meeting.ended',
      payload: { object: { id: created.zoomMeetingId! } },
    });
    await service.handleWebhookEvent({
      event_id: 'c',
      event: 'meeting.participant_joined',
      payload: { object: { id: created.zoomMeetingId! } },
    });

    const all = await service.listWebhookEvents(TENANT, { page: 1, limit: 25 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);
    // Orden DESC por receivedAt: el más reciente primero.
    expect(all.items[0]!.eventId).toBe('c');

    const onlyOk = await service.listWebhookEvents(TENANT, {
      page: 1,
      limit: 25,
      result: 'OK',
    });
    expect(onlyOk.total).toBe(2);
    expect(onlyOk.items.every((e) => e.result === 'OK')).toBe(true);

    const onlyStarted = await service.listWebhookEvents(TENANT, {
      page: 1,
      limit: 25,
      eventType: 'meeting.started',
    });
    expect(onlyStarted.total).toBe(1);
    expect(onlyStarted.items[0]!.eventId).toBe('a');

    // Pagina con limit=1.
    const firstPage = await service.listWebhookEvents(TENANT, { page: 1, limit: 1 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.items).toHaveLength(1);
    const secondPage = await service.listWebhookEvents(TENANT, { page: 2, limit: 1 });
    expect(secondPage.items[0]!.eventId).not.toBe(firstPage.items[0]!.eventId);
  });

  it('aísla por tenant: no devuelve eventos de otros tenants', async () => {
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
    await service.handleWebhookEvent({
      event_id: 'evt-tenant-iso',
      event: 'meeting.started',
      payload: { object: { id: created.zoomMeetingId! } },
    });

    const otroTenant = await service.listWebhookEvents('tenant-otro', { page: 1, limit: 25 });
    expect(otroTenant.total).toBe(0);
    expect(otroTenant.items).toHaveLength(0);
  });
});

describe('ZoomLiveService.testCredentials', () => {
  it('con stub devuelve kind=stub y accountId fake', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const result = await service.testCredentials(TENANT);
    expect(result.kind).toBe('stub');
    expect(result.accountId).toBe('stub-account');
  });
});
