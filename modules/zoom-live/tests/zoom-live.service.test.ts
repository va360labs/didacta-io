import { describe, expect, it } from 'vitest';
import { ZoomLiveService } from '../src/zoom-live.service.js';
import {
  AttendanceNotAvailableError,
  NotRegisteredError,
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
  zoomMeetingUuid: string | null;
  joinUrl: string | null;
  startUrl: string | null;
  recordingUrl: string | null;
  recordingDurationMinutes: number | null;
  attendanceSyncedAt: Date | null;
  attendanceSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AttendanceRow {
  id: string;
  tenantId: string;
  sessionId: string;
  userId: string | null;
  zoomEmail: string | null;
  zoomName: string | null;
  zoomParticipantId: string | null;
  clickedJoinAt: Date | null;
  present: boolean;
  minutes: number;
  joinedAt: Date | null;
  leftAt: Date | null;
  manualPresent: boolean | null;
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
  const attendances: AttendanceRow[] = [];

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
    _attendances: attendances,
    modZoomSession: {
      async findMany(args: {
        where: {
          tenantId?: string;
          courseId?: string;
          status?: string | { in: string[] };
          attendanceSyncedAt?: null;
          startTime?: { gte?: Date; lte?: Date };
        };
        orderBy?: { startTime?: 'asc' | 'desc' };
        take?: number;
      }) {
        const rows = sessions
          .filter((s) => (args.where.tenantId ? s.tenantId === args.where.tenantId : true))
          .filter((s) => (args.where.courseId ? s.courseId === args.where.courseId : true))
          .filter((s) => {
            const st = args.where.status;
            if (!st) return true;
            return typeof st === 'string' ? s.status === st : st.in.includes(s.status);
          })
          .filter((s) =>
            args.where.attendanceSyncedAt === null ? s.attendanceSyncedAt === null : true,
          )
          .filter((s) =>
            args.where.startTime?.gte ? s.startTime >= args.where.startTime.gte : true,
          )
          .filter((s) =>
            args.where.startTime?.lte ? s.startTime <= args.where.startTime.lte : true,
          )
          .sort((a, b) =>
            args.orderBy?.startTime === 'asc'
              ? a.startTime.getTime() - b.startTime.getTime()
              : b.startTime.getTime() - a.startTime.getTime(),
          )
          .map(withCount);
        return args.take ? rows.slice(0, args.take) : rows;
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
          zoomMeetingUuid: null,
          joinUrl: null,
          startUrl: null,
          attendanceSyncedAt: null,
          attendanceSyncError: null,
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
    modZoomSessionAttendance: {
      async findFirst(args: {
        where: { tenantId: string; sessionId: string; userId?: string | null };
      }) {
        return (
          attendances.find(
            (a) =>
              a.tenantId === args.where.tenantId &&
              a.sessionId === args.where.sessionId &&
              (args.where.userId === undefined ? true : a.userId === args.where.userId),
          ) ?? null
        );
      },
      async findMany(args: {
        where: { tenantId: string; sessionId: string; userId?: string | null };
      }) {
        return attendances
          .filter((a) => a.tenantId === args.where.tenantId)
          .filter((a) => a.sessionId === args.where.sessionId)
          .filter((a) => (args.where.userId === undefined ? true : a.userId === args.where.userId));
      },
      async create(args: { data: Partial<AttendanceRow> & Pick<AttendanceRow, 'id'> }) {
        const dup = attendances.some(
          (a) =>
            a.sessionId === args.data.sessionId &&
            a.userId != null &&
            a.userId === args.data.userId,
        );
        if (dup) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row: AttendanceRow = {
          tenantId: '',
          sessionId: '',
          userId: null,
          zoomEmail: null,
          zoomName: null,
          zoomParticipantId: null,
          clickedJoinAt: null,
          present: false,
          minutes: 0,
          joinedAt: null,
          leftAt: null,
          manualPresent: null,
          ...args.data,
        } as AttendanceRow;
        attendances.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: Partial<AttendanceRow> }) {
        const idx = attendances.findIndex((a) => a.id === args.where.id);
        if (idx === -1) throw new Error('not found');
        attendances[idx] = { ...attendances[idx]!, ...args.data };
        return attendances[idx]!;
      },
    },
    user: {
      async findMany(args: {
        where: { tenantId: string; id?: { in: string[] }; email?: { in: string[] } };
        select?: unknown;
      }) {
        return users
          .filter((u) => u.tenantId === args.where.tenantId)
          .filter((u) => (args.where.id ? args.where.id.in.includes(u.id) : true))
          .filter((u) => (args.where.email ? args.where.email.in.includes(u.email) : true));
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
    // Sin `announce` explícito la clase NO se anuncia: una prueba no puede
    // acabar publicada en el feed por descuido.
    expect(ctx.events[0]?.data).toMatchObject({ announce: false });
  });

  it('propaga la intención de anunciar la clase en el evento', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());

    await service.create(TENANT, ACTOR, {
      topic: 'Masterclass',
      startTime: '2026-08-03T16:00:00+02:00',
      durationMinutes: 90,
      hostEmail: 'host@example.com',
      timezone: 'Europe/Madrid',
      announce: true,
    });

    expect(ctx.events[0]?.data).toMatchObject({ announce: true });
  });

  it('editar propaga la intención de anunciar, para publicar una clase que no lo estaba', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());

    const creada = await service.create(TENANT, ACTOR, {
      topic: 'Sin anunciar',
      startTime: '2026-08-03T16:00:00+02:00',
      durationMinutes: 60,
      hostEmail: 'host@example.com',
      timezone: 'Europe/Madrid',
    });

    await service.update(TENANT, ACTOR, creada.id, { topic: 'Ya anunciada', announce: true });

    const updated = ctx.events.find((e) => e.name === 'zoom.session.updated');
    expect(updated?.data).toMatchObject({ sessionId: creada.id, announce: true });
  });

  it('editar sin pedir anuncio no lo pide (el consumidor solo re-sincroniza)', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());

    const creada = await service.create(TENANT, ACTOR, {
      topic: 'Clase',
      startTime: '2026-08-03T16:00:00+02:00',
      durationMinutes: 60,
      hostEmail: 'host@example.com',
      timezone: 'Europe/Madrid',
    });

    await service.update(TENANT, ACTOR, creada.id, { durationMinutes: 90 });

    const updated = ctx.events.find((e) => e.name === 'zoom.session.updated');
    expect(updated?.data).toMatchObject({ announce: false });
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

/**
 * Asistencia real (ADR-018). Cubre las dos fuentes —click de entrada y
 * reconciliación con Zoom— y sobre todo que nunca se presente una como la
 * otra: el `confidence` de cada fila tiene que decir la verdad.
 */
describe('ZoomLiveService · asistencia (ADR-018)', () => {
  const ALUMNO = 'user-alumno';
  const OTRO = 'user-otro';

  function makeUsers(): FakeUser[] {
    return [
      {
        id: ALUMNO,
        tenantId: TENANT,
        name: 'Ana Alumna',
        email: 'ana@example.com',
        avatarUrl: null,
      },
      { id: OTRO, tenantId: TENANT, name: 'Otro', email: 'otro@example.com', avatarUrl: null },
    ];
  }

  /** Cliente Zoom con participantes controlados desde el test. */
  function fakeApi(
    participants: Array<{
      participantId?: string | null;
      name?: string | null;
      email?: string | null;
      joinTime?: string | null;
      leaveTime?: string | null;
      durationSeconds?: number | null;
    }>,
    source: 'REPORT' | 'PAST_MEETING' = 'REPORT',
  ) {
    const stub = new StubZoomApiClient();
    return {
      createMeeting: stub.createMeeting.bind(stub),
      deleteMeeting: stub.deleteMeeting.bind(stub),
      updateMeeting: stub.updateMeeting.bind(stub),
      testCredentials: stub.testCredentials.bind(stub),
      async getPastMeetingParticipants() {
        return {
          source,
          participants: participants.map((p) => ({
            participantId: p.participantId ?? null,
            name: p.name ?? null,
            email: p.email ?? null,
            joinTime: p.joinTime ?? null,
            leaveTime: p.leaveTime ?? null,
            durationSeconds: p.durationSeconds ?? null,
          })),
        };
      },
    };
  }

  async function seedSession(service: ZoomLiveService) {
    return service.create(TENANT, ACTOR, {
      topic: 'Clase con asistencia',
      startTime: '2026-05-15T10:00:00+00:00',
      durationMinutes: 60,
      hostEmail: 'host@example.com',
      timezone: 'UTC',
    });
  }

  /** Lleva la sesión a ENDED como haría el webhook real de Zoom. */
  async function endSession(service: ZoomLiveService, meetingId: string, eventId: string) {
    await service.handleWebhookEvent({
      event_id: eventId,
      event: 'meeting.ended',
      payload: { object: { id: meetingId } },
    });
  }

  it('markJoinClick exige inscripción y sella solo el primer click', async () => {
    const prisma = makeFakePrisma([], makeUsers());
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const session = await seedSession(service);

    // Sin inscribirse no hay enlace: mismo gating que el joinUrl (ADR-017).
    await expect(service.markJoinClick(TENANT, ALUMNO, session.id)).rejects.toThrow(
      NotRegisteredError,
    );

    await service.register(TENANT, ALUMNO, session.id);
    const first = await service.markJoinClick(TENANT, ALUMNO, session.id);
    expect(first.joinUrl).toMatch(/stub-zoom/);

    const clickedAt = prisma._attendances[0]!.clickedJoinAt;
    expect(clickedAt).toBeInstanceOf(Date);

    await service.markJoinClick(TENANT, ALUMNO, session.id);
    expect(prisma._attendances).toHaveLength(1);
    expect(prisma._attendances[0]!.clickedJoinAt).toBe(clickedAt);
  });

  it('sin sincronizar, el click cuenta como asistencia pero con confidence PROXY', async () => {
    const prisma = makeFakePrisma([], makeUsers());
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const session = await seedSession(service);

    await service.register(TENANT, ALUMNO, session.id);
    await service.register(TENANT, OTRO, session.id);
    await service.markJoinClick(TENANT, ALUMNO, session.id);

    const report = await service.getAttendance(TENANT, session.id);
    expect(report.registeredCount).toBe(2);
    expect(report.attendedCount).toBe(1);
    expect(report.syncedAt).toBeNull();

    const ana = report.rows.find((r) => r.userId === ALUMNO)!;
    expect(ana.attended).toBe(true);
    expect(ana.confidence).toBe('PROXY');
    expect(ana.minutes).toBe(0);

    const otro = report.rows.find((r) => r.userId === OTRO)!;
    expect(otro.attended).toBe(false);
    expect(otro.confidence).toBe('NONE');
  });

  it('sincroniza con Zoom: casa por email, suma reconexiones y marca confidence ZOOM', async () => {
    const prisma = makeFakePrisma([], makeUsers());
    const ctx = makeCtx();
    const api = fakeApi([
      // Ana se cae y vuelve: dos tramos que hay que sumar (20 + 25 = 45).
      {
        participantId: 'p-ana',
        name: 'Ana',
        email: 'ana@example.com',
        joinTime: '2026-05-15T10:00:00Z',
        leaveTime: '2026-05-15T10:20:00Z',
      },
      {
        participantId: 'p-ana',
        name: 'Ana',
        email: 'ana@example.com',
        joinTime: '2026-05-15T10:25:00Z',
        leaveTime: '2026-05-15T10:50:00Z',
      },
      // Invitado que no es miembro del tenant: se conserva sin userId.
      {
        participantId: 'p-x',
        name: 'iPhone de Juan',
        joinTime: '2026-05-15T10:05:00Z',
        leaveTime: '2026-05-15T10:15:00Z',
      },
    ]);
    const service = new ZoomLiveService(prisma as never, ctx as never, api as never);
    const session = await seedSession(service);
    await service.register(TENANT, ALUMNO, session.id);
    await service.register(TENANT, OTRO, session.id);
    await endSession(service, session.zoomMeetingId!, 'evt-att-1');

    const report = await service.syncAttendance(TENANT, session.id);
    expect(report.syncedAt).not.toBeNull();
    expect(report.syncError).toBeNull();

    const ana = report.rows.find((r) => r.userId === ALUMNO)!;
    expect(ana.attended).toBe(true);
    expect(ana.confidence).toBe('ZOOM');
    expect(ana.minutes).toBe(45);

    // Inscrito que no apareció: Zoom ya habló, así que es una ausencia firme.
    const otro = report.rows.find((r) => r.userId === OTRO)!;
    expect(otro.attended).toBe(false);
    expect(otro.confidence).toBe('ZOOM');

    // El invitado sigue visible para que el formador lo reconozca.
    const sinCasar = report.rows.filter((r) => r.userId === null);
    expect(sinCasar).toHaveLength(1);
    expect(sinCasar[0]!.zoomName).toBe('iPhone de Juan');
    expect(report.attendedCount).toBe(2); // Ana + el invitado

    // Idempotente: repetir no duplica filas ni altera los minutos.
    const again = await service.syncAttendance(TENANT, session.id);
    expect(again.rows).toHaveLength(report.rows.length);
    expect(again.rows.find((r) => r.userId === ALUMNO)!.minutes).toBe(45);
  });

  it('una vez sincronizado, el click sin presencia en Zoom deja de contar', async () => {
    const prisma = makeFakePrisma([], makeUsers());
    const ctx = makeCtx();
    // Zoom no reporta a nadie: la clase se abrió pero Ana no llegó a entrar.
    const service = new ZoomLiveService(prisma as never, ctx as never, fakeApi([]) as never);
    const session = await seedSession(service);
    await service.register(TENANT, ALUMNO, session.id);
    await service.markJoinClick(TENANT, ALUMNO, session.id);

    const before = await service.getAttendance(TENANT, session.id);
    expect(before.rows.find((r) => r.userId === ALUMNO)!.attended).toBe(true);

    await endSession(service, session.zoomMeetingId!, 'evt-att-2');
    const after = await service.syncAttendance(TENANT, session.id);

    const ana = after.rows.find((r) => r.userId === ALUMNO)!;
    expect(ana.attended).toBe(false);
    expect(ana.confidence).toBe('ZOOM');
    expect(ana.clickedJoinAt).not.toBeNull(); // la evidencia no se destruye
  });

  it('el fallback past_meetings confirma presencia sin minutos', async () => {
    const prisma = makeFakePrisma([], makeUsers());
    const ctx = makeCtx();
    const api = fakeApi(
      [{ participantId: 'p-ana', name: 'Ana', email: 'ana@example.com' }],
      'PAST_MEETING',
    );
    const service = new ZoomLiveService(prisma as never, ctx as never, api as never);
    const session = await seedSession(service);
    await service.register(TENANT, ALUMNO, session.id);
    await endSession(service, session.zoomMeetingId!, 'evt-att-3');

    const report = await service.syncAttendance(TENANT, session.id);
    const ana = report.rows.find((r) => r.userId === ALUMNO)!;
    expect(ana.attended).toBe(true);
    expect(ana.minutes).toBe(0);
  });

  it('si Zoom falla, deja el motivo en syncError sin marcar la sesión como sincronizada', async () => {
    const prisma = makeFakePrisma([], makeUsers());
    const ctx = makeCtx();
    const stub = new StubZoomApiClient();
    const api = {
      createMeeting: stub.createMeeting.bind(stub),
      deleteMeeting: stub.deleteMeeting.bind(stub),
      updateMeeting: stub.updateMeeting.bind(stub),
      testCredentials: stub.testCredentials.bind(stub),
      async getPastMeetingParticipants() {
        throw new Error('Invalid access token, does not contain scopes:[report:read:admin]');
      },
    };
    const service = new ZoomLiveService(prisma as never, ctx as never, api as never);
    const session = await seedSession(service);
    await service.register(TENANT, ALUMNO, session.id);
    await endSession(service, session.zoomMeetingId!, 'evt-att-4');

    const report = await service.syncAttendance(TENANT, session.id);
    expect(report.syncedAt).toBeNull();
    expect(report.syncError).toContain('report:read:admin');
  });

  it('el override manual pisa el cálculo y se puede revertir', async () => {
    const prisma = makeFakePrisma([], makeUsers());
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, fakeApi([]) as never);
    const session = await seedSession(service);
    await service.register(TENANT, ALUMNO, session.id);
    await endSession(service, session.zoomMeetingId!, 'evt-att-5');
    await service.syncAttendance(TENANT, session.id);

    const marked = await service.setManualAttendance(TENANT, session.id, ALUMNO, true);
    const ana = marked.rows.find((r) => r.userId === ALUMNO)!;
    expect(ana.attended).toBe(true);
    expect(ana.confidence).toBe('MANUAL');

    const reverted = await service.setManualAttendance(TENANT, session.id, ALUMNO, null);
    const anaAgain = reverted.rows.find((r) => r.userId === ALUMNO)!;
    expect(anaAgain.attended).toBe(false);
    expect(anaAgain.confidence).toBe('ZOOM');
  });

  it('el webhook persiste el uuid de la ocurrencia para poder pedir el informe', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const session = await seedSession(service);

    await service.handleWebhookEvent({
      event_id: 'evt-att-uuid',
      event: 'meeting.started',
      payload: { object: { id: session.zoomMeetingId!, uuid: 'aDbLoAbCdEf==' } },
    });

    expect(prisma._sessions[0]!.zoomMeetingUuid).toBe('aDbLoAbCdEf==');
  });

  it('no se puede reconciliar una clase que aún no ha empezado ni una cancelada', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const session = await seedSession(service);

    await expect(service.syncAttendance(TENANT, session.id)).rejects.toThrow(
      AttendanceNotAvailableError,
    );

    await service.cancel(TENANT, ACTOR, session.id);
    await expect(service.syncAttendance(TENANT, session.id)).rejects.toThrow(
      AttendanceNotAvailableError,
    );
  });

  it('no reconcilia una clase EN CURSO: sellaría syncedAt con datos parciales', async () => {
    const prisma = makeFakePrisma([], makeUsers());
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, fakeApi([]) as never);

    // Empieza dentro de 5 min y dura una hora: cuando el webhook la pone
    // STARTED, todavía no ha terminado.
    const inFive = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const session = await service.create(TENANT, ACTOR, {
      topic: 'En curso ahora',
      startTime: inFive,
      durationMinutes: 60,
      hostEmail: 'host@example.com',
      timezone: 'UTC',
    });
    await service.handleWebhookEvent({
      event_id: 'evt-att-en-curso',
      event: 'meeting.started',
      payload: { object: { id: session.zoomMeetingId! } },
    });

    await expect(service.syncAttendance(TENANT, session.id)).rejects.toThrow(
      AttendanceNotAvailableError,
    );
    // Y la UI no ofrece el botón mientras tanto.
    expect((await service.getAttendance(TENANT, session.id)).canSync).toBe(false);
    expect(prisma._sessions[0]!.attendanceSyncedAt).toBeNull();
  });

  it('el worker solo recoge sesiones cuya hora de fin ya pasó y sin sincronizar', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const now = new Date('2026-05-15T12:00:00Z');

    // Terminó hace rato (10:00 + 60min + margen < 12:00): entra.
    const terminada = await service.create(TENANT, ACTOR, {
      topic: 'Terminada',
      startTime: '2026-05-15T10:00:00+00:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });
    // Empezó hace 5 min y dura 60: todavía en curso, no entra.
    const enCurso = await service.create(TENANT, ACTOR, {
      topic: 'En curso',
      startTime: '2026-05-15T11:55:00+00:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });
    for (const [i, s] of [terminada, enCurso].entries()) {
      await service.handleWebhookEvent({
        event_id: `evt-att-worker-${i}`,
        event: 'meeting.started',
        payload: { object: { id: s.zoomMeetingId! } },
      });
    }

    const pending = await service.listSessionsPendingAttendanceSync(now);
    expect(pending.map((p) => p.id)).toEqual([terminada.id]);

    // Tras sincronizar, deja de aparecer.
    await service.syncAttendance(TENANT, terminada.id);
    expect(await service.listSessionsPendingAttendanceSync(now)).toHaveLength(0);
  });
});
