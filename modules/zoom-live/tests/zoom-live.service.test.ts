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
  reminderSentAt: Date | null;
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

function makeFakePrisma(
  courses: { id: string; tenantId: string }[] = [],
  users: FakeUser[] = [],
  tenants: { id: string; name: string }[] = [],
) {
  const sessions: SessionRow[] = [];
  const webhookEvents: WebhookEventRow[] = [];
  const registrations: RegistrationRow[] = [];
  const attendances: AttendanceRow[] = [];

  /** Proyección `select` de Prisma: solo las claves pedidas con `true`. */
  const project = (row: SessionRow, select: Record<string, boolean>) =>
    Object.fromEntries(
      Object.entries(select)
        .filter(([, wanted]) => wanted)
        .map(([key]) => [key, row[key as keyof SessionRow]]),
    );

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
          reminderSentAt?: null;
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
          .filter((s) => (args.where.reminderSentAt === null ? s.reminderSentAt === null : true))
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
      async findFirst(args: {
        where: { tenantId?: string; id?: string; zoomMeetingId?: string };
        select?: Record<string, boolean>;
      }) {
        const found = sessions.find((s) => {
          if (args.where.tenantId && s.tenantId !== args.where.tenantId) return false;
          if (args.where.id && s.id !== args.where.id) return false;
          if (args.where.zoomMeetingId && s.zoomMeetingId !== args.where.zoomMeetingId)
            return false;
          return true;
        });
        if (!found) return null;
        // Prisma proyecta de verdad cuando hay `select`. El fake tiene que
        // hacerlo también: hay lecturas (el evento de calendario, que es
        // público) cuya garantía ES que el joinUrl no sale del service.
        return args.select ? project(found, args.select) : withCount(found);
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
          reminderSentAt: null,
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
        where: {
          id: string;
          tenantId?: string;
          status?: string | { notIn: string[] };
          reminderSentAt?: null;
        };
        data: Partial<SessionRow>;
      }) {
        let count = 0;
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i]!;
          if (s.id !== args.where.id) continue;
          if (args.where.tenantId && s.tenantId !== args.where.tenantId) continue;
          const status = args.where.status;
          if (typeof status === 'string' && s.status !== status) continue;
          if (typeof status === 'object' && status.notIn.includes(s.status)) continue;
          if (args.where.reminderSentAt === null && s.reminderSentAt !== null) continue;
          sessions[i] = { ...s, ...args.data, updatedAt: new Date() };
          count++;
        }
        return { count };
      },
    },
    tenant: {
      async findUnique(args: { where: { id: string }; select?: unknown }) {
        return tenants.find((t) => t.id === args.where.id) ?? null;
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
      // El unique de `event_id` es lo que reclama el evento: sin el, dos
      // entregas concurrentes hacian el trabajo las dos.
      async update(args: { where: { eventId: string }; data: Partial<WebhookEventRow> }) {
        const row = webhookEvents.find((e) => e.eventId === args.where.eventId);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data);
        return row;
      },
      async create(args: {
        data: Omit<WebhookEventRow, 'receivedAt' | 'sessionId' | 'tenantId' | 'errorMessage'> &
          Partial<WebhookEventRow>;
      }) {
        if (webhookEvents.some((e) => e.eventId === args.data.eventId)) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`event_id`)'), {
            code: 'P2002',
          });
        }
        // En CI los inserts caen dentro del mismo milisegundo y un sort
        // por receivedAt no es determinístico. Garantizamos +1ms por
        // cada insert para reproducir el orden estable que Prisma+
        // PostgreSQL emiten via `orderBy: [receivedAt, id]`.
        const lastTs = webhookEvents.length
          ? webhookEvents[webhookEvents.length - 1]!.receivedAt.getTime()
          : Date.now();
        const row: WebhookEventRow = {
          sessionId: null,
          tenantId: null,
          errorMessage: null,
          ...args.data,
          receivedAt: new Date(lastTs + 1),
        } as WebhookEventRow;
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

/**
 * Tope de la fila de un índice btree de Postgres. `outbox_event` tiene un
 * índice único sobre `(tenant_id, idempotency_key)`: una clave que no quepa
 * hace fallar el INSERT del evento con este mismo mensaje (comprobado contra
 * Postgres 16; lo cubre también
 * `apps/api/tests/integration/outbox-idempotency-key.integration.test.ts`).
 */
const BTREE_MAX_ROW = 2704;

function makeCtx(opts: { outboxComoPostgres?: boolean } = {}) {
  const events: { name: string; data: unknown }[] = [];
  /** Claves de idempotencia con las que se publicó cada evento, en orden. */
  const keys: string[] = [];
  return {
    eventBus: {
      async publish(evt: { name: string; data: unknown; metadata?: { idempotencyKey?: string } }) {
        const key = evt.metadata?.idempotencyKey ?? '';
        if (opts.outboxComoPostgres && Buffer.byteLength(key) > BTREE_MAX_ROW) {
          throw new Error(
            `index row size ${Buffer.byteLength(key)} exceeds btree version 4 maximum ${BTREE_MAX_ROW} ` +
              'for index "outbox_event_tenant_id_idempotency_key_key"',
          );
        }
        keys.push(key);
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
    keys,
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

  it('con el tenant verificado de OTRA aula, la clase no existe para el aviso: IGNORED y sin tocarla', async () => {
    // El id de la reunión lo escribe quien firma el aviso. El host pasa el
    // tenant cuyo secreto verificó la firma; una clase de otro tenant no puede
    // cambiar de estado ni recibir una grabación por un aviso que no es suyo.
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'Clase del aula víctima',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });
    const eventosAntes = ctx.events.length;

    const started = await service.handleWebhookEvent(
      {
        event_id: 'evt-ajeno-1',
        event: 'meeting.started',
        payload: { object: { id: created.zoomMeetingId! } },
      },
      { tenantId: 'otra-aula' },
    );
    const recording = await service.handleWebhookEvent(
      {
        event_id: 'evt-ajeno-2',
        event: 'recording.completed',
        payload: {
          object: { id: created.zoomMeetingId!, share_url: 'https://phishing.example/x' },
        },
      },
      { tenantId: 'otra-aula' },
    );

    expect(started).toEqual({ result: 'IGNORED' });
    expect(recording).toEqual({ result: 'IGNORED' });
    // El aviso se archiva A NOMBRE DEL AULA VERIFICADA, desde que se reclama y
    // también al cerrarlo sin clase local. La tabla tiene RLS: una fila sin
    // `tenant_id` en contexto de aula la rechaza la base (era un 500).
    expect(
      prisma._webhookEvents.map((e) => [e.eventId, e.tenantId, e.sessionId, e.result]),
    ).toEqual([
      ['evt-ajeno-1', 'otra-aula', null, 'IGNORED'],
      ['evt-ajeno-2', 'otra-aula', null, 'IGNORED'],
    ]);
    const after = await service.get(TENANT, created.id);
    expect(after.status).toBe('SCHEDULED');
    expect(after.recordingUrl ?? null).toBeNull();
    expect(ctx.events).toHaveLength(eventosAntes);

    // Control: el mismo aviso con el tenant dueño sí se aplica.
    const propio = await service.handleWebhookEvent(
      {
        event_id: 'evt-propio-1',
        event: 'meeting.started',
        payload: { object: { id: created.zoomMeetingId! } },
      },
      { tenantId: TENANT },
    );
    expect(propio).toEqual({ result: 'OK', sessionId: created.id });
    expect((await service.get(TENANT, created.id)).status).toBe('STARTED');
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

  it('cancelar una clase LLENA avisa a todos: la clave del evento ya no crece con los inscritos', async () => {
    // El payload lleva a todos los inscritos, y la clave de idempotencia
    // llevaba el payload entero. Con unos setenta inscritos dejaba de caber en
    // el índice único del outbox: la clase quedaba cancelada (en Zoom y en la
    // base), el evento no se guardaba, nadie recibía el aviso, y reintentar no
    // servía porque la sesión ya estaba CANCELLED.
    const prisma = makeFakePrisma();
    const ctx = makeCtx({ outboxComoPostgres: true });
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    const inscritos = Array.from(
      { length: 200 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const userId of inscritos) await service.register(TENANT, userId, created.id);

    await service.cancel(TENANT, ACTOR, created.id);

    const cancelled = ctx.events.find((e) => e.name === 'zoom.session.cancelled');
    expect(cancelled, 'el evento de cancelación no llegó al outbox').toBeDefined();
    // Van TODOS: acotar la clave no recorta el payload.
    expect((cancelled!.data as { registeredUserIds: string[] }).registeredUserIds).toHaveLength(
      200,
    );
    expect(Math.max(...ctx.keys.map((k) => k.length))).toBeLessThanOrEqual(256);
    expect((await service.get(TENANT, created.id)).status).toBe('CANCELLED');
  });

  it('todas las claves que publica el módulo caben de sobra en el índice del outbox', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await makeSession(service);
    await service.register(TENANT, ALUMNO, created.id);
    await service.unregister(TENANT, ALUMNO, created.id);
    await service.cancel(TENANT, ACTOR, created.id);

    expect(ctx.keys.length).toBeGreaterThanOrEqual(4);
    for (const key of ctx.keys) {
      // nombre : resumen del payload : instante — sin el payload dentro.
      expect(key).toMatch(/^zoom\.session\.[a-z_.]+:[0-9a-f]{32}:\d+$/);
    }
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

describe('ZoomLiveService · recordatorio 2h antes', () => {
  const NOW = new Date('2026-05-15T12:00:00Z');

  /** Crea una sesión que empieza `minutes` minutos después de NOW. */
  async function sessionStartingIn(service: ZoomLiveService, topic: string, minutes: number) {
    return service.create(TENANT, ACTOR, {
      topic,
      startTime: new Date(NOW.getTime() + minutes * 60_000).toISOString(),
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'Europe/Madrid',
    });
  }

  it('recoge solo las clases que empiezan dentro de la ventana de aviso', async () => {
    const prisma = makeFakePrisma();
    const service = new ZoomLiveService(
      prisma as never,
      makeCtx() as never,
      new StubZoomApiClient(),
    );

    const dentro = await sessionStartingIn(service, 'Empieza en 90 min', 90);
    const inminente = await sessionStartingIn(service, 'Empieza en 20 min', 20);
    await sessionStartingIn(service, 'Empieza mañana', 26 * 60);
    // Empezó hace media hora: el aviso ya no sirve para nada.
    await sessionStartingIn(service, 'Ya empezada', -30);

    const due = await service.listSessionsPendingReminder(NOW, 2);
    // Orden por startTime ascendente: primero la más inminente.
    expect(due.map((d) => d.id)).toEqual([inminente.id, dentro.id]);
  });

  it('el claim es de un solo ganador: dos barridos concurrentes no avisan dos veces', async () => {
    const prisma = makeFakePrisma();
    const service = new ZoomLiveService(
      prisma as never,
      makeCtx() as never,
      new StubZoomApiClient(),
    );
    const session = await sessionStartingIn(service, 'Clase con aviso', 90);

    expect(await service.claimReminder(TENANT, session.id, NOW)).toBe(true);
    expect(await service.claimReminder(TENANT, session.id, NOW)).toBe(false);
    // Y ya no vuelve a salir en el barrido.
    expect(await service.listSessionsPendingReminder(NOW, 2)).toHaveLength(0);
  });

  it('reprogramar la clase rearma el recordatorio', async () => {
    const prisma = makeFakePrisma();
    const service = new ZoomLiveService(
      prisma as never,
      makeCtx() as never,
      new StubZoomApiClient(),
    );
    const session = await sessionStartingIn(service, 'Clase que se mueve', 90);
    await service.claimReminder(TENANT, session.id, NOW);
    expect(await service.listSessionsPendingReminder(NOW, 2)).toHaveLength(0);

    // Se mueve a dentro de 100 minutos: el aviso enviado hablaba de otra hora.
    await service.update(TENANT, ACTOR, session.id, {
      startTime: new Date(NOW.getTime() + 100 * 60_000).toISOString(),
    });

    expect((await service.listSessionsPendingReminder(NOW, 2)).map((d) => d.id)).toEqual([
      session.id,
    ]);
  });

  it('una clase cancelada deja de recibir recordatorio', async () => {
    const prisma = makeFakePrisma();
    const service = new ZoomLiveService(
      prisma as never,
      makeCtx() as never,
      new StubZoomApiClient(),
    );
    const session = await sessionStartingIn(service, 'Clase cancelada', 60);

    await service.cancel(TENANT, ACTOR, session.id);
    expect(await service.listSessionsPendingReminder(NOW, 2)).toHaveLength(0);
  });

  it('getCalendarInfo devuelve lo público de la clase con el nombre del tenant', async () => {
    const prisma = makeFakePrisma([], [], [{ id: TENANT, name: 'Demo' }]);
    const service = new ZoomLiveService(
      prisma as never,
      makeCtx() as never,
      new StubZoomApiClient(),
    );
    const session = await sessionStartingIn(service, 'Clase pública', 90);

    const info = await service.getCalendarInfo(session.id);
    expect(info).toMatchObject({
      id: session.id,
      tenantId: TENANT,
      topic: 'Clase pública',
      durationMinutes: 60,
      timezone: 'Europe/Madrid',
      status: 'SCHEDULED',
      organizerName: 'Demo',
    });
    // No hay campo alguno que exponga el enlace de Zoom (ADR-017).
    expect(JSON.stringify(info)).not.toMatch(/stub-zoom|joinUrl/);
    expect(await service.getCalendarInfo('11111111-2222-3333-4444-555555555555')).toBeNull();
  });

  it('listRegisteredUserIds devuelve los inscritos del tenant', async () => {
    const prisma = makeFakePrisma();
    const service = new ZoomLiveService(
      prisma as never,
      makeCtx() as never,
      new StubZoomApiClient(),
    );
    const session = await sessionStartingIn(service, 'Clase con inscritos', 90);

    await service.register(TENANT, 'alumno-1', session.id);
    await service.register(TENANT, 'alumno-2', session.id);

    expect((await service.listRegisteredUserIds(TENANT, session.id)).sort()).toEqual([
      'alumno-1',
      'alumno-2',
    ]);
  });
});

describe('ZoomLiveService.resolveWebhookTenantId (mitad lookup del patrón F3)', () => {
  it('resuelve el tenant de la sesión local por zoomMeetingId', async () => {
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

    const tenantId = await service.resolveWebhookTenantId({
      event_id: 'evt-res-1',
      event: 'meeting.started',
      payload: { object: { id: created.zoomMeetingId! } },
    });

    expect(tenantId).toBe(TENANT);
  });

  it('meeting desconocido o payload sin id → null (el host procesa sancionado)', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());

    expect(
      await service.resolveWebhookTenantId({
        event_id: 'evt-res-2',
        event: 'meeting.started',
        payload: { object: { id: 999999999 } },
      }),
    ).toBeNull();

    expect(
      await service.resolveWebhookTenantId({
        event_id: 'evt-res-3',
        event: 'meeting.started',
        payload: { object: {} },
      }),
    ).toBeNull();
  });
});

describe('ZoomLiveService.getWebhookSecret (A2 — antes vivía en env ZOOM_WEBHOOK_SECRET)', () => {
  function makeCtxWithConfig(store: Map<string, unknown>) {
    const base = makeCtx();
    return {
      ...base,
      config: {
        async get<T>(tenantId: string, moduleName: string, key: string): Promise<T | undefined> {
          return store.get(`${tenantId}.${moduleName}.${key}`) as T | undefined;
        },
      },
    };
  }

  it('devuelve el webhookSecret guardado junto a las credenciales del tenant', async () => {
    const prisma = makeFakePrisma();
    const store = new Map<string, unknown>();
    store.set(`${TENANT}.zoom-live.credentials`, { webhookSecret: 'sekret-123' });
    const ctx = makeCtxWithConfig(store);
    const service = new ZoomLiveService(prisma as never, ctx as never);

    expect(await service.getWebhookSecret(TENANT)).toBe('sekret-123');
  });

  it('null si el tenant no configuró credenciales', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtxWithConfig(new Map());
    const service = new ZoomLiveService(prisma as never, ctx as never);

    expect(await service.getWebhookSecret(TENANT)).toBeNull();
  });

  it('null si hay credenciales S2S pero sin webhookSecret', async () => {
    const prisma = makeFakePrisma();
    const store = new Map<string, unknown>();
    store.set(`${TENANT}.zoom-live.credentials`, {
      accountId: 'a',
      clientId: 'c',
      clientSecret: 's',
    });
    const ctx = makeCtxWithConfig(store);
    const service = new ZoomLiveService(prisma as never, ctx as never);

    expect(await service.getWebhookSecret(TENANT)).toBeNull();
  });

  it('null si ctx.config no está disponible (host sin TenantConfigService)', async () => {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never);

    expect(await service.getWebhookSecret(TENANT)).toBeNull();
  });

  it('aísla por tenant: el secret de un tenant no se filtra a otro', async () => {
    const prisma = makeFakePrisma();
    const store = new Map<string, unknown>();
    store.set(`${TENANT}.zoom-live.credentials`, { webhookSecret: 'sekret-del-tenant-1' });
    const ctx = makeCtxWithConfig(store);
    const service = new ZoomLiveService(prisma as never, ctx as never);

    expect(await service.getWebhookSecret('otro-tenant')).toBeNull();
  });
});

describe('ZoomLiveService.handleWebhookEvent · avisos reales de Zoom (sin event_id)', () => {
  /**
   * Zoom no manda `event_id` en el cuerpo. Estos avisos tienen la forma real:
   * `{ event, event_ts, payload }`. La clave de idempotencia sale del contenido.
   */
  async function setup() {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'Clase real',
      startTime: '2026-05-15T10:00:00-03:00',
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'UTC',
    });
    const aviso = (event: string, eventTs: number, uuid = 'uuid-ocurrencia-1==') => ({
      event,
      event_ts: eventTs,
      payload: { account_id: 'acc-1', object: { id: created.zoomMeetingId!, uuid } },
    });
    return { prisma, ctx, service, created, aviso };
  }

  it('un meeting.started sin event_id se APLICA: la clase pasa a STARTED', async () => {
    const { service, created, aviso, ctx, prisma } = await setup();

    const out = await service.handleWebhookEvent(aviso('meeting.started', 1_778_850_000_000));

    expect(out).toEqual({ result: 'OK', sessionId: created.id });
    expect((await service.get(TENANT, created.id)).status).toBe('STARTED');
    expect(ctx.events.map((e) => e.name)).toContain('zoom.session.started');
    // Queda archivado con una clave propia, no con un hueco.
    expect(prisma._webhookEvents).toHaveLength(1);
    expect(prisma._webhookEvents[0]!.eventId).toMatch(/^derived-[0-9a-f]{40}$/);
    expect(prisma._webhookEvents[0]!.result).toBe('OK');
  });

  it('la reentrega del mismo aviso es DUPLICATE: no se aplica ni se publica dos veces', async () => {
    const { service, aviso, ctx, prisma } = await setup();
    const started = aviso('meeting.started', 1_778_850_000_000);

    const first = await service.handleWebhookEvent(started);
    // Zoom reintenta con el mismo cuerpo (otra petición, mismo suceso).
    const second = await service.handleWebhookEvent(JSON.parse(JSON.stringify(started)));

    expect(first.result).toBe('OK');
    expect(second.result).toBe('DUPLICATE');
    expect(ctx.events.filter((e) => e.name === 'zoom.session.started')).toHaveLength(1);
    expect(prisma._webhookEvents).toHaveLength(1);
  });

  it('started y ended de la misma reunión son dos sucesos: se aplican los dos', async () => {
    const { service, created, aviso, ctx } = await setup();

    const a = await service.handleWebhookEvent(aviso('meeting.started', 1_778_850_000_000));
    const b = await service.handleWebhookEvent(aviso('meeting.ended', 1_778_853_600_000));

    expect(a.result).toBe('OK');
    // Sin clave propia, el segundo aviso chocaba con el primero (los dos
    // «sin id») y la clase se quedaba en STARTED para siempre.
    expect(b.result).toBe('OK');
    expect((await service.get(TENANT, created.id)).status).toBe('ENDED');
    expect(ctx.events.map((e) => e.name)).toEqual(
      expect.arrayContaining(['zoom.session.started', 'zoom.session.ended']),
    );
  });

  it('dos ocurrencias de una reunión recurrente no se pisan', async () => {
    const { service, aviso, prisma } = await setup();

    const lunes = await service.handleWebhookEvent(aviso('meeting.started', 1_778_850_000_000));
    const martes = await service.handleWebhookEvent(
      aviso('meeting.started', 1_778_936_400_000, 'uuid-ocurrencia-2=='),
    );

    expect(lunes.result).toBe('OK');
    expect(martes.result).toBe('OK');
    expect(prisma._webhookEvents).toHaveLength(2);
  });

  it('sin event_ts la clave sale del cuerpo crudo que pasa el host', async () => {
    const { service, created, prisma } = await setup();
    const event = { event: 'meeting.started', payload: { object: { id: created.zoomMeetingId! } } };
    const rawBody = JSON.stringify(event);

    const first = await service.handleWebhookEvent(event, { rawBody });
    const second = await service.handleWebhookEvent(event, { rawBody });

    expect(first.result).toBe('OK');
    expect(second.result).toBe('DUPLICATE');
    expect(prisma._webhookEvents).toHaveLength(1);
  });

  it('si reclamar el aviso falla por algo que NO es un duplicado, el error sale: no se da por visto', async () => {
    const { service, created, aviso, prisma } = await setup();
    // Un fallo de base cualquiera (no la unique de `event_id`).
    prisma.modZoomWebhookEvent.create = async () => {
      throw new Error('connection terminated unexpectedly');
    };

    await expect(
      service.handleWebhookEvent(aviso('meeting.started', 1_778_850_000_000)),
    ).rejects.toThrow('connection terminated unexpectedly');
    // Devolver DUPLICATE aquí era contestar 200 a Zoom: no reintentaba y el
    // aviso se perdía sin rastro.
    expect((await service.get(TENANT, created.id)).status).toBe('SCHEDULED');
  });
});

describe('ZoomLiveService.handleWebhookEvent · avisos fuera de la hora de la clase', () => {
  /**
   * Clase el 9 de noviembre a las 17:30 (Madrid). Antes, cualquier
   * `meeting.ended` la cerraba: bastaba con que el formador abriese la reunión
   * dos días antes para probarla. La clase quedaba «terminada», se cerraban las
   * inscripciones y se lanzaba la encuesta post-clase a todos.
   */
  const STARTS_AT = '2026-11-09T17:30:00+01:00';
  const at = (iso: string) => ({ now: new Date(iso) });

  async function setup() {
    const prisma = makeFakePrisma();
    const ctx = makeCtx();
    const service = new ZoomLiveService(prisma as never, ctx as never, new StubZoomApiClient());
    const created = await service.create(TENANT, ACTOR, {
      topic: 'Clase del lunes',
      startTime: STARTS_AT,
      durationMinutes: 60,
      hostEmail: 'h@x.com',
      timezone: 'Europe/Madrid',
    });
    ctx.events.length = 0;
    let n = 0;
    const aviso = (event: string, object: Record<string, unknown> = {}) => ({
      event_id: `evt-fuera-de-hora-${++n}`,
      event,
      payload: { object: { id: created.zoomMeetingId!, ...object } },
    });
    const status = async () => (await service.get(TENANT, created.id)).status;
    const names = () => ctx.events.map((e) => e.name);
    return { prisma, ctx, service, created, aviso, status, names };
  }

  it('un meeting.ended dos días antes NO cierra la clase ni lanza la encuesta', async () => {
    const { service, created, aviso, status, names, prisma } = await setup();

    const out = await service.handleWebhookEvent(
      aviso('meeting.ended'),
      at('2026-11-07T19:05:00+01:00'),
    );

    expect(out).toEqual({ result: 'IGNORED', sessionId: created.id });
    expect(await status()).toBe('SCHEDULED');
    // `zoom.session.ended` es lo que dispara la encuesta post-clase.
    expect(names()).not.toContain('zoom.session.ended');
    // Queda archivado con el motivo, para que el admin vea por qué no se aplicó.
    expect(prisma._webhookEvents[0]).toMatchObject({
      result: 'IGNORED',
      sessionId: created.id,
      errorMessage: 'ZOOM_EVENT_OUT_OF_SCHEDULE',
    });
  });

  it('un meeting.started dos días antes NO la pone en directo', async () => {
    const { service, aviso, status, names } = await setup();

    const out = await service.handleWebhookEvent(
      aviso('meeting.started'),
      at('2026-11-07T19:00:00+01:00'),
    );

    expect(out.result).toBe('IGNORED');
    expect(await status()).toBe('SCHEDULED');
    expect(names()).not.toContain('zoom.session.started');
  });

  it('abrir 20 minutos antes sí es la clase: pasa a STARTED', async () => {
    const { service, aviso, status } = await setup();
    const out = await service.handleWebhookEvent(
      aviso('meeting.started'),
      at('2026-11-09T17:10:00+01:00'),
    );
    expect(out.result).toBe('OK');
    expect(await status()).toBe('STARTED');
  });

  it('si la reunión se abre dentro del margen y se cierra antes de la hora, la clase vuelve a programada', async () => {
    const { service, aviso, status, names } = await setup();
    await service.handleWebhookEvent(aviso('meeting.started'), at('2026-11-09T17:10:00+01:00'));
    expect(await status()).toBe('STARTED');

    const out = await service.handleWebhookEvent(
      aviso('meeting.ended'),
      at('2026-11-09T17:20:00+01:00'),
    );

    expect(out.result).toBe('IGNORED');
    // Ni «en directo» (ya no hay nadie) ni «terminada» (no se ha dado).
    expect(await status()).toBe('SCHEDULED');
    expect(names()).not.toContain('zoom.session.ended');
  });

  it('CONTROL: la clase de verdad se abre, se da y se cierra como siempre', async () => {
    const { service, aviso, status, names } = await setup();

    const a = await service.handleWebhookEvent(
      aviso('meeting.started'),
      at('2026-11-09T17:28:00+01:00'),
    );
    const b = await service.handleWebhookEvent(
      aviso('meeting.ended'),
      at('2026-11-09T18:35:00+01:00'),
    );

    expect(a.result).toBe('OK');
    expect(b.result).toBe('OK');
    expect(await status()).toBe('ENDED');
    expect(names()).toEqual(['zoom.session.started', 'zoom.session.ended']);
  });

  it('una prueba de días antes no estropea la clase: el día de verdad todo se aplica', async () => {
    const { service, created, aviso, status, names } = await setup();
    // La prueba del formador, el sábado.
    await service.handleWebhookEvent(aviso('meeting.started'), at('2026-11-07T19:00:00+01:00'));
    await service.handleWebhookEvent(aviso('meeting.ended'), at('2026-11-07T19:05:00+01:00'));
    expect(await status()).toBe('SCHEDULED');
    // Con la clase programada, un alumno todavía puede inscribirse.
    await expect(service.register(TENANT, 'alumno-1', created.id)).resolves.toMatchObject({
      isRegistered: true,
    });

    // El lunes.
    await service.handleWebhookEvent(aviso('meeting.started'), at('2026-11-09T17:29:00+01:00'));
    await service.handleWebhookEvent(aviso('meeting.ended'), at('2026-11-09T18:31:00+01:00'));

    expect(await status()).toBe('ENDED');
    expect(names().filter((n) => n === 'zoom.session.ended')).toHaveLength(1);
  });

  it('cuenta cuándo ocurrió, no cuándo llegó: un ended de la prueba reentregado con la clase empezada no la cierra', async () => {
    const { service, status, created } = await setup();
    await service.handleWebhookEvent(
      {
        event: 'meeting.started',
        event_ts: new Date('2026-11-09T17:29:00+01:00').getTime(),
        payload: { object: { id: created.zoomMeetingId! } },
      },
      at('2026-11-09T17:29:01+01:00'),
    );
    expect(await status()).toBe('STARTED');

    // El `meeting.ended` de una prueba de las 16:40, que Zoom reintenta a las 17:45.
    const out = await service.handleWebhookEvent(
      {
        event: 'meeting.ended',
        event_ts: new Date('2026-11-09T16:40:00+01:00').getTime(),
        payload: { object: { id: created.zoomMeetingId! } },
      },
      at('2026-11-09T17:45:00+01:00'),
    );

    expect(out.result).toBe('IGNORED');
    // La clase está en marcha de verdad: NO vuelve a programada por un aviso viejo.
    expect(await status()).toBe('STARTED');
  });

  it('la grabación de una prueba no se cuelga en la clase', async () => {
    const { service, created, aviso, names } = await setup();

    const out = await service.handleWebhookEvent(
      aviso('recording.completed', {
        share_url: 'https://zoom.example.test/rec/prueba',
        duration: 2,
        recording_files: [{ recording_end: '2026-11-07T18:07:00Z' }],
      }),
      // El aviso de grabación puede tardar: llega con la clase ya dada.
      at('2026-11-09T19:00:00+01:00'),
    );

    expect(out.result).toBe('IGNORED');
    const after = await service.get(TENANT, created.id, { userId: 'staff', isStaff: true });
    expect(after.recordingUrl).toBeNull();
    expect(names()).not.toContain('zoom.session.recording_ready');
  });

  it('CONTROL: la grabación de la clase sí se guarda', async () => {
    const { service, created, aviso, names } = await setup();

    const out = await service.handleWebhookEvent(
      aviso('recording.completed', {
        share_url: 'https://zoom.example.test/rec/clase',
        duration: 61,
        recording_files: [{ recording_end: '2026-11-09T17:31:00Z' }],
      }),
      at('2026-11-09T19:00:00+01:00'),
    );

    expect(out.result).toBe('OK');
    const after = await service.get(TENANT, created.id, { userId: 'staff', isStaff: true });
    expect(after.recordingUrl).toBe('https://zoom.example.test/rec/clase');
    expect(names()).toContain('zoom.session.recording_ready');
  });

  it('una clase cancelada sigue sin resucitar, sea la hora que sea', async () => {
    const { service, created, aviso, status } = await setup();
    await service.cancel(TENANT, ACTOR, created.id);

    const out = await service.handleWebhookEvent(
      aviso('meeting.started'),
      at('2026-11-09T17:29:00+01:00'),
    );

    expect(out.result).toBe('IGNORED');
    expect(await status()).toBe('CANCELLED');
  });
});
