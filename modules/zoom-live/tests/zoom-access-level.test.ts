import { describe, expect, it } from 'vitest';
import { ZoomLiveService, type ZoomAccessGroupMembership } from '../src/zoom-live.service.js';
import { SessionAccessGroupUnknownError, SessionLockedError } from '../src/errors.js';

/**
 * Clases en directo restringidas por nivel de membresía (grupos de acceso),
 * sin base: un doble de Prisma con lo justo y un doble del puerto de
 * pertenencia. La prueba contra Postgres real está en
 * apps/api/tests/integration/espacios-directos-por-nivel.integration.test.ts.
 */

const T = 'tenant-1';

interface Row {
  id: string;
  tenantId: string;
  courseId: null;
  lessonId: null;
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
  accessGroupIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

function session(id: string, accessGroupIds: string[]): Row {
  return {
    id,
    tenantId: T,
    courseId: null,
    lessonId: null,
    topic: `Clase ${id}`,
    description: 'Agenda privada',
    status: 'SCHEDULED',
    startTime: new Date('2026-12-01T18:00:00Z'),
    durationMinutes: 60,
    timezone: 'Europe/Madrid',
    hostEmail: 'profe@example.com',
    zoomMeetingId: '123',
    joinUrl: 'https://zoom.example.com/j/123',
    startUrl: 'https://zoom.example.com/s/123',
    recordingUrl: 'https://zoom.example.com/rec/123',
    recordingDurationMinutes: 55,
    accessGroupIds,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(opts: {
  sessions: Row[];
  registrations?: Array<{ sessionId: string; userId: string }>;
  staff?: string[];
  members?: Record<string, string[]>;
  names?: Record<string, string>;
}) {
  const regs = [...(opts.registrations ?? [])];
  const attendance: Array<{ id: string; sessionId: string; userId: string }> = [];
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const withCount = (s: Row) => ({
    ...s,
    _count: { registrations: regs.filter((r) => r.sessionId === s.id).length },
  });
  const find = (where: { id?: string; tenantId?: string }) =>
    opts.sessions.find(
      (s) => (!where.id || s.id === where.id) && (!where.tenantId || s.tenantId === where.tenantId),
    );
  const prisma = {
    modZoomSession: {
      findMany: async () => opts.sessions.map(withCount),
      findFirst: async (args: { where: { id?: string; tenantId?: string } }) => {
        const s = find(args.where);
        return s ? withCount(s) : null;
      },
      updateMany: async (args: { where: { id: string }; data: { status: string } }) => {
        const s = find({ id: args.where.id });
        if (!s || s.status === 'CANCELLED') return { count: 0 };
        s.status = args.data.status;
        return { count: 1 };
      },
      create: async (args: { data: Row }) => ({
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    modZoomSessionRegistration: {
      findMany: async (args: {
        where: { sessionId?: string | { in: string[] }; userId?: string };
      }) =>
        regs
          .filter((r) => {
            const s = args.where.sessionId;
            if (!s) return true;
            return typeof s === 'string' ? r.sessionId === s : s.in.includes(r.sessionId);
          })
          .filter((r) => !args.where.userId || r.userId === args.where.userId),
      findUnique: async (args: {
        where: { mod_zoom_session_registration_unique: { sessionId: string; userId: string } };
      }) => {
        const k = args.where.mod_zoom_session_registration_unique;
        return regs.find((r) => r.sessionId === k.sessionId && r.userId === k.userId) ?? null;
      },
      create: async (args: { data: { sessionId: string; userId: string } }) => {
        regs.push({ sessionId: args.data.sessionId, userId: args.data.userId });
        return args.data;
      },
      deleteMany: async () => ({ count: 0 }),
    },
    modZoomSessionAttendance: {
      findFirst: async () => null,
      create: async (args: { data: { id: string; sessionId: string; userId: string } }) => {
        attendance.push(args.data);
        return args.data;
      },
    },
    user: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.filter((id) => (opts.staff ?? []).includes(id)).map((id) => ({ id })),
    },
  };
  const members = opts.members ?? {};
  const membership: ZoomAccessGroupMembership = {
    activeGroupIdsOf: async (_t, userId) => members[userId] ?? [],
    activeMembersAmong: async (_t, groupIds, userIds) =>
      userIds.filter((u) => (members[u] ?? []).some((g) => groupIds.includes(g))),
    groupNames: async (_t, ids) =>
      ids.filter((id) => opts.names?.[id]).map((id) => ({ id, name: opts.names![id]! })),
  };
  const ctx = {
    eventBus: {
      publish: async (e: { name: string; data: Record<string, unknown> }) => {
        events.push({ name: e.name, data: e.data });
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
  const service = new ZoomLiveService(prisma as never, ctx as never, undefined, membership);
  return { service, regs, attendance, events };
}

const PRO = 'g-pro';
const NAMES = { [PRO]: 'Pro' };

describe('ZoomLiveService · clases por nivel', () => {
  it('sin el nivel: listado y detalle CERRADOS (solo título, hora y niveles)', async () => {
    const { service } = setup({
      sessions: [session('s-pro', [PRO]), session('s-abierta', [])],
      registrations: [{ sessionId: 's-pro', userId: 'u-basico' }],
      names: NAMES,
    });
    const viewer = { userId: 'u-basico', isStaff: false };
    const [pro, abierta] = await service.list(T, {}, viewer);
    expect(pro).toMatchObject({
      id: 's-pro',
      topic: 'Clase s-pro',
      locked: true,
      description: null,
      joinUrl: null,
      recordingUrl: null,
      recordingDurationMinutes: null,
      zoomMeetingId: null,
      hostEmail: '',
      isRegistered: false,
      accessLevels: [{ id: PRO, name: 'Pro' }],
      accessGroupIds: [],
    });
    expect(abierta).toMatchObject({ locked: false, description: 'Agenda privada' });
    const detalle = await service.get(T, 's-pro', viewer);
    expect(detalle.locked).toBe(true);
    expect(JSON.stringify(detalle)).not.toContain('zoom.example.com');
  });

  it('con el nivel o siendo staff: abierta (el staff ve además los grupos)', async () => {
    const { service } = setup({
      sessions: [session('s-pro', [PRO])],
      registrations: [{ sessionId: 's-pro', userId: 'u-pro' }],
      members: { 'u-pro': [PRO] },
      names: NAMES,
    });
    const delPro = await service.get(T, 's-pro', { userId: 'u-pro', isStaff: false });
    expect(delPro).toMatchObject({
      locked: false,
      joinUrl: 'https://zoom.example.com/j/123',
      accessGroupIds: [],
    });
    const delStaff = await service.getForHost(T, 's-pro', { userId: 'u-profe', isStaff: true });
    expect(delStaff).toMatchObject({ locked: false, accessGroupIds: [PRO] });
  });

  it('inscribirse y pedir el enlace sin el nivel: SessionLockedError (aun inscrito antes)', async () => {
    const { service, regs, attendance } = setup({
      sessions: [session('s-pro', [PRO])],
      registrations: [{ sessionId: 's-pro', userId: 'u-viejo' }],
    });
    await expect(service.register(T, 'u-basico', 's-pro')).rejects.toBeInstanceOf(
      SessionLockedError,
    );
    expect(regs).toHaveLength(1);
    await expect(service.markJoinClick(T, 'u-viejo', 's-pro')).rejects.toBeInstanceOf(
      SessionLockedError,
    );
    expect(attendance).toHaveLength(0);
    // Staff: entra aunque no tenga el nivel.
    await expect(service.markJoinClick(T, 'u-profe', 's-pro', true)).resolves.toEqual({
      joinUrl: 'https://zoom.example.com/j/123',
    });
    await expect(service.register(T, 'u-profe', 's-pro', true)).resolves.toMatchObject({
      locked: false,
    });
  });

  it('recordatorios y aviso de cancelación: solo a quien todavía puede verla', async () => {
    const { service, events } = setup({
      sessions: [session('s-pro', [PRO])],
      registrations: [
        { sessionId: 's-pro', userId: 'u-pro' },
        { sessionId: 's-pro', userId: 'u-perdio' },
        { sessionId: 's-pro', userId: 'u-profe' },
      ],
      staff: ['u-profe'],
      members: { 'u-pro': [PRO] },
    });
    expect(await service.listRegisteredUserIds(T, 's-pro')).toEqual(['u-pro', 'u-profe']);
    expect(await service.canView(T, 's-pro', { userId: 'u-perdio', isStaff: false })).toBe(false);
    expect(await service.canView(T, 's-pro', { userId: 'u-pro', isStaff: false })).toBe(true);
    expect(await service.canView(T, 'no-existe', { userId: 'u-pro', isStaff: true })).toBe(false);

    await service.cancel(T, 'u-profe', 's-pro');
    const ev = events.find((e) => e.name === 'zoom.session.cancelled');
    expect(ev?.data['registeredUserIds']).toEqual(['u-pro', 'u-profe']);
  });

  it('una clase abierta no consulta grupos y avisa a todos los inscritos', async () => {
    const { service } = setup({
      sessions: [session('s-abierta', [])],
      registrations: [
        { sessionId: 's-abierta', userId: 'a' },
        { sessionId: 's-abierta', userId: 'b' },
      ],
    });
    expect(await service.listRegisteredUserIds(T, 's-abierta')).toEqual(['a', 'b']);
  });

  it('crear con un nivel que no existe (o borrado) falla antes de crear nada', async () => {
    const { service, events } = setup({ sessions: [], names: NAMES });
    await expect(
      service.create(T, 'u-profe', {
        topic: 'X',
        startTime: '2026-12-01T18:00:00Z',
        durationMinutes: 30,
        timezone: 'Europe/Madrid',
        hostEmail: 'profe@example.com',
        externalJoinUrl: 'https://meet.example.com/x',
        accessGroupIds: [PRO, 'g-borrado'],
      }),
    ).rejects.toBeInstanceOf(SessionAccessGroupUnknownError);
    expect(events).toHaveLength(0);
    const ok = await service.create(T, 'u-profe', {
      topic: 'X',
      startTime: '2026-12-01T18:00:00Z',
      durationMinutes: 30,
      timezone: 'Europe/Madrid',
      hostEmail: 'profe@example.com',
      externalJoinUrl: 'https://meet.example.com/x',
      accessGroupIds: [PRO, PRO],
    });
    expect(ok).toMatchObject({ accessGroupIds: [PRO], accessLevels: [{ id: PRO, name: 'Pro' }] });
  });
});
