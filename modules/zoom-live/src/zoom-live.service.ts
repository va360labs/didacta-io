import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  type AttendanceConfidence,
  type AttendanceReport,
  type AttendanceView,
  type CreateSessionDto,
  type ListWebhookEventsQuery,
  type PaginatedWebhookEvents,
  type RegistrationView,
  type SessionView,
  type SessionViewer,
  type UpdateSessionDto,
  type SessionStatus,
  type WebhookEventView,
  type ZoomParticipantRecord,
  type ZoomWebhookEvent,
} from './dto.js';
import {
  AttendanceNotAvailableError,
  CourseNotInTenantError,
  LessonNotInCourseError,
  NotRegisteredError,
  SessionAlreadyEndedError,
  SessionNotFoundError,
  SessionNotOpenForRegistrationError,
} from './errors.js';
import { buildZoomApiClient, StubZoomApiClient, type ZoomApiClient } from './zoom-api-client.js';

export class ZoomLiveService {
  /**
   * Cliente fijo inyectado en el constructor (override para tests). Si es
   * undefined, `clientFor(tenantId)` resuelve uno por tenant leyendo
   * `tenant_settings` con clave `zoom-live.credentials`.
   */
  private readonly fixedApi?: ZoomApiClient;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
    api?: ZoomApiClient,
  ) {
    this.fixedApi = api;
  }

  /**
   * Resuelve el cliente Zoom para un tenant concreto. Si tiene credenciales
   * S2S configuradas vía `tenant_settings`, usa `RealZoomApiClient`; si no,
   * cae al stub determinístico para no romper el flujo en dev.
   *
   * No cacheamos el cliente (las credenciales pueden rotarse en caliente
   * desde el panel de configuración del tenant).
   */
  private async clientFor(tenantId: string): Promise<ZoomApiClient> {
    if (this.fixedApi) return this.fixedApi;
    if (!this.ctx.config) return new StubZoomApiClient();
    const creds = await this.ctx.config
      .get<unknown>(tenantId, 'zoom-live', 'credentials')
      .catch(() => undefined);
    return buildZoomApiClient(creds);
  }

  /**
   * Lista sesiones del tenant. `viewer` decide el gating (ADR-017): sin
   * viewer, o con viewer no-staff y no inscrito, `joinUrl` y
   * `recordingUrl` se serializan como NULL. `from`/`to` acotan por
   * `startTime` (los usa el calendario para pedir un mes concreto).
   */
  async list(
    tenantId: string,
    opts: {
      courseId?: string;
      lessonId?: string;
      status?: SessionStatus;
      from?: Date;
      to?: Date;
    } = {},
    viewer?: SessionViewer,
  ): Promise<SessionView[]> {
    const rows = await this.prisma.modZoomSession.findMany({
      where: {
        tenantId,
        ...(opts.courseId ? { courseId: opts.courseId } : {}),
        ...(opts.lessonId ? { lessonId: opts.lessonId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.from || opts.to
          ? {
              startTime: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lte: opts.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { startTime: 'desc' },
      include: { _count: { select: { registrations: true } } },
    });

    const mineSet = await this.registeredSessionIds(
      tenantId,
      viewer,
      rows.map((r) => r.id),
    );

    return rows.map((r) =>
      this.toView(r, {
        includeStartUrl: false,
        includeJoinUrl: (viewer?.isStaff ?? false) || mineSet.has(r.id),
        registeredCount: r._count.registrations,
        isRegistered: mineSet.has(r.id),
      }),
    );
  }

  async get(tenantId: string, sessionId: string, viewer?: SessionViewer): Promise<SessionView> {
    const row = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
      include: { _count: { select: { registrations: true } } },
    });
    if (!row) throw new SessionNotFoundError(sessionId);
    const mineSet = await this.registeredSessionIds(tenantId, viewer, [sessionId]);
    return this.toView(row, {
      includeStartUrl: false,
      includeJoinUrl: (viewer?.isStaff ?? false) || mineSet.has(sessionId),
      registeredCount: row._count.registrations,
      isRegistered: mineSet.has(sessionId),
    });
  }

  /**
   * Variante que incluye `startUrl` — solo para el host o admins. La
   * separación a nivel de método obliga al controller a decidir
   * explícitamente quién puede ver la URL de inicio.
   */
  async getForHost(
    tenantId: string,
    sessionId: string,
    viewer?: SessionViewer,
  ): Promise<SessionView> {
    const row = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
      include: { _count: { select: { registrations: true } } },
    });
    if (!row) throw new SessionNotFoundError(sessionId);
    const mineSet = await this.registeredSessionIds(tenantId, viewer, [sessionId]);
    return this.toView(row, {
      includeStartUrl: true,
      includeJoinUrl: true,
      registeredCount: row._count.registrations,
      isRegistered: mineSet.has(sessionId),
    });
  }

  /**
   * Inscribe a un miembro en una sesión. Idempotente: repetir la
   * inscripción no duplica fila ni re-emite el evento. Solo se admite
   * mientras la sesión está SCHEDULED o STARTED.
   */
  async register(tenantId: string, userId: string, sessionId: string): Promise<SessionView> {
    const session = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!session) throw new SessionNotFoundError(sessionId);
    if (session.status === 'ENDED' || session.status === 'CANCELLED') {
      throw new SessionNotOpenForRegistrationError();
    }

    const existing = await this.prisma.modZoomSessionRegistration.findUnique({
      where: { mod_zoom_session_registration_unique: { sessionId, userId } },
    });
    if (!existing) {
      let createdNow = false;
      try {
        await this.prisma.modZoomSessionRegistration.create({
          data: { id: randomUUID(), tenantId, sessionId, userId },
        });
        createdNow = true;
      } catch (e) {
        // Carrera entre dos inscripciones concurrentes del mismo user:
        // la unique (session_id, user_id) gana y tratamos el segundo
        // intento como idempotente (sin re-emitir el evento).
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }

      if (createdNow) {
        // Cierre de la carrera register↔cancel: si la sesión pasó a
        // CANCELLED/ENDED mientras insertábamos (y por tanto el snapshot
        // de inscritos del cancel() no nos incluyó), deshacemos la fila y
        // rechazamos — el usuario no queda inscrito a una clase muerta ni
        // recibe confirmación sin su aviso de cancelación.
        const fresh = await this.prisma.modZoomSession.findFirst({
          where: { tenantId, id: sessionId },
          select: { status: true },
        });
        if (!fresh || fresh.status === 'ENDED' || fresh.status === 'CANCELLED') {
          await this.prisma.modZoomSessionRegistration.deleteMany({
            where: { tenantId, sessionId, userId },
          });
          throw new SessionNotOpenForRegistrationError();
        }

        try {
          await this.publish(tenantId, userId, 'zoom.session.registration.created', {
            sessionId,
            userId,
            topic: session.topic,
            startTime: session.startTime.toISOString(),
            timezone: session.timezone,
            courseId: session.courseId,
          });
        } catch (e) {
          // Best-effort: la inscripción ya está persistida y un retry del
          // usuario no re-publicaría (path idempotente). Mejor inscribir
          // sin email de confirmación que fallar la inscripción.
          this.ctx.logger.warn('mod.zoom-live: fallo publicando registration.created', {
            tenantId,
            sessionId,
            userId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return this.get(tenantId, sessionId, { userId, isStaff: false });
  }

  /**
   * Baja de una inscripción. Idempotente: si no había fila devuelve
   * `unregistered: false` sin error.
   */
  async unregister(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<{ unregistered: boolean }> {
    const session = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
      select: { id: true },
    });
    if (!session) throw new SessionNotFoundError(sessionId);

    const deleted = await this.prisma.modZoomSessionRegistration.deleteMany({
      where: { tenantId, sessionId, userId },
    });
    if (deleted.count === 0) return { unregistered: false };

    await this.publish(tenantId, userId, 'zoom.session.registration.cancelled', {
      sessionId,
      userId,
    });
    return { unregistered: true };
  }

  /**
   * Roster de inscritos con identidad (solo staff — el controller gatea).
   * Lee la tabla core `user` (no es tabla de otro módulo) filtrando por
   * `tenantId` para resolver nombre/email/avatar.
   */
  async listRegistrations(tenantId: string, sessionId: string): Promise<RegistrationView[]> {
    const session = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
      select: { id: true },
    });
    if (!session) throw new SessionNotFoundError(sessionId);

    const rows = await this.prisma.modZoomSessionRegistration.findMany({
      where: { tenantId, sessionId },
      orderBy: { registeredAt: 'asc' },
    });
    if (rows.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { tenantId, id: { in: rows.map((r) => r.userId) } },
      select: { id: true, name: true, email: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    return rows.map((r) => {
      const u = byId.get(r.userId);
      return {
        userId: r.userId,
        name: u?.name ?? null,
        email: u?.email ?? '',
        avatarUrl: u?.avatarUrl ?? null,
        registeredAt: r.registeredAt.toISOString(),
      };
    });
  }

  // ------------------- asistencia (ADR-018) -------------------

  /**
   * Registra que el usuario pulsó "Unirme" y devuelve el `joinUrl`. Es el
   * proxy de entrada: la única fuente de asistencia atribuible al 100% a un
   * `userId`, porque ocurre dentro de Didacta y no depende de con qué
   * identidad entre luego en Zoom.
   *
   * Solo sella el PRIMER click: interesa cuándo entró, no cuántas veces
   * pulsó. Idempotente y sin efectos si repite.
   */
  async markJoinClick(
    tenantId: string,
    userId: string,
    sessionId: string,
    isStaff = false,
  ): Promise<{ joinUrl: string }> {
    const session = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!session) throw new SessionNotFoundError(sessionId);
    if (session.status === 'CANCELLED') throw new SessionNotOpenForRegistrationError();

    // Mismo gating que el `joinUrl` del detalle (ADR-017): sin inscripción no
    // hay enlace, y el servidor es quien lo decide.
    if (!isStaff) {
      const registered = await this.prisma.modZoomSessionRegistration.findUnique({
        where: { mod_zoom_session_registration_unique: { sessionId, userId } },
      });
      if (!registered) throw new NotRegisteredError();
    }
    if (!session.joinUrl) {
      throw new AttendanceNotAvailableError('Esta clase todavía no tiene enlace de Zoom.');
    }

    const existing = await this.prisma.modZoomSessionAttendance.findFirst({
      where: { tenantId, sessionId, userId },
    });
    try {
      if (!existing) {
        await this.prisma.modZoomSessionAttendance.create({
          data: {
            id: randomUUID(),
            tenantId,
            sessionId,
            userId,
            clickedJoinAt: new Date(),
          },
        });
      } else if (!existing.clickedJoinAt) {
        await this.prisma.modZoomSessionAttendance.update({
          where: { id: existing.id },
          data: { clickedJoinAt: new Date() },
        });
      }
    } catch (e) {
      // Doble click concurrente: la unique (session_id, user_id) gana. El
      // enlace se sirve igual — perder el sello sería peor que servirlo.
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }

    return { joinUrl: session.joinUrl };
  }

  /** Informe de asistencia de una sesión (solo staff — el controller gatea). */
  async getAttendance(tenantId: string, sessionId: string): Promise<AttendanceReport> {
    const session = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!session) throw new SessionNotFoundError(sessionId);
    return this.buildAttendanceReport(tenantId, session);
  }

  /**
   * Reconcilia la asistencia contra Zoom: pide los participantes del meeting
   * terminado y los casa con miembros del tenant **por email**. Los que no
   * casan se conservan con su identidad de Zoom para que el formador los
   * concilie a mano.
   *
   * Idempotente: se puede repetir sin duplicar filas ni perder los overrides
   * manuales. Nunca lanza por un fallo de Zoom — deja el motivo en
   * `syncError` para que el formador vea qué falta (típicamente el scope
   * `report:read:admin`) en vez de un 502 opaco.
   */
  async syncAttendance(tenantId: string, sessionId: string): Promise<AttendanceReport> {
    const session = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!session) throw new SessionNotFoundError(sessionId);
    if (session.status === 'CANCELLED') {
      throw new AttendanceNotAvailableError('La clase fue cancelada: no hay asistencia que leer.');
    }
    if (session.status === 'SCHEDULED') {
      throw new AttendanceNotAvailableError('La clase todavía no ha empezado.');
    }
    // Una clase en curso no se reconcilia: el pull sellaría `syncedAt` con
    // datos parciales y el worker dejaría de mirarla, congelando la
    // asistencia a mitad de clase. STARTED solo se admite cuando su hora de
    // fin ya pasó (caso real: el webhook `meeting.ended` nunca llegó).
    if (session.status === 'STARTED' && !hasFinished(session, new Date())) {
      throw new AttendanceNotAvailableError(
        'La clase sigue en curso: la asistencia se cierra cuando termine.',
      );
    }
    const meetingRef = session.zoomMeetingUuid ?? session.zoomMeetingId;
    if (!meetingRef) {
      throw new AttendanceNotAvailableError('Esta clase no tiene un meeting de Zoom asociado.');
    }

    let participants: ZoomParticipantRecord[];
    let source: 'REPORT' | 'PAST_MEETING';
    try {
      const api = await this.clientFor(tenantId);
      const result = await api.getPastMeetingParticipants(meetingRef);
      participants = result.participants;
      source = result.source;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.ctx.logger.warn('mod.zoom-live: fallo leyendo participantes de Zoom', {
        tenantId,
        sessionId,
        meetingRef,
        error: message,
      });
      await this.prisma.modZoomSession.update({
        where: { id: sessionId },
        data: { attendanceSyncError: message.slice(0, 500) },
      });
      const fresh = await this.prisma.modZoomSession.findFirst({
        where: { tenantId, id: sessionId },
      });
      return this.buildAttendanceReport(tenantId, fresh ?? session);
    }

    const aggregated = aggregateParticipants(participants);
    const matched = await this.matchParticipantsToUsers(tenantId, aggregated);

    for (const entry of aggregated) {
      const userId = matched.get(entry.key) ?? null;
      const data = {
        zoomEmail: entry.email,
        zoomName: entry.name,
        zoomParticipantId: entry.participantId,
        present: true,
        // El fallback `past_meetings` no reporta duración: 0 minutos con
        // present=true significa "entró, no sabemos cuánto".
        minutes: source === 'REPORT' ? entry.minutes : 0,
        joinedAt: entry.joinedAt,
        leftAt: entry.leftAt,
      };

      const existing = userId
        ? await this.prisma.modZoomSessionAttendance.findFirst({
            where: { tenantId, sessionId, userId },
          })
        : await this.findUnmatchedAttendance(tenantId, sessionId, entry);

      if (existing) {
        await this.prisma.modZoomSessionAttendance.update({
          where: { id: existing.id },
          data,
        });
      } else {
        try {
          await this.prisma.modZoomSessionAttendance.create({
            data: { id: randomUUID(), tenantId, sessionId, userId, ...data },
          });
        } catch (e) {
          // El worker y el botón manual pueden reconciliar la misma sesión a
          // la vez: la unique (session_id, user_id) decide quién inserta y el
          // perdedor actualiza la fila del ganador. Sin esto, el formador
          // vería un 500 por una carrera que no le importa.
          if ((e as { code?: string }).code !== 'P2002' || !userId) throw e;
          const winner = await this.prisma.modZoomSessionAttendance.findFirst({
            where: { tenantId, sessionId, userId },
          });
          if (!winner) throw e;
          await this.prisma.modZoomSessionAttendance.update({
            where: { id: winner.id },
            data,
          });
        }
      }
    }

    await this.prisma.modZoomSession.update({
      where: { id: sessionId },
      data: { attendanceSyncedAt: new Date(), attendanceSyncError: null },
    });

    await this.publish(tenantId, null, 'zoom.session.attendance_synced', {
      sessionId,
      participants: aggregated.length,
      source,
    });

    const fresh = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    return this.buildAttendanceReport(tenantId, fresh ?? session);
  }

  /**
   * Override manual del formador. `present = null` lo quita y devuelve la
   * fila al cálculo automático — nunca destruimos la evidencia original.
   */
  async setManualAttendance(
    tenantId: string,
    sessionId: string,
    userId: string,
    present: boolean | null,
  ): Promise<AttendanceReport> {
    const session = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!session) throw new SessionNotFoundError(sessionId);

    const existing = await this.prisma.modZoomSessionAttendance.findFirst({
      where: { tenantId, sessionId, userId },
    });
    if (existing) {
      await this.prisma.modZoomSessionAttendance.update({
        where: { id: existing.id },
        data: { manualPresent: present },
      });
    } else {
      try {
        await this.prisma.modZoomSessionAttendance.create({
          data: { id: randomUUID(), tenantId, sessionId, userId, manualPresent: present },
        });
      } catch (e) {
        // Carrera con una reconciliación en curso: la unique decide y aquí
        // solo hay que aplicar el override sobre la fila que ganó.
        if ((e as { code?: string }).code !== 'P2002') throw e;
        const winner = await this.prisma.modZoomSessionAttendance.findFirst({
          where: { tenantId, sessionId, userId },
        });
        if (!winner) throw e;
        await this.prisma.modZoomSessionAttendance.update({
          where: { id: winner.id },
          data: { manualPresent: present },
        });
      }
    }

    return this.buildAttendanceReport(tenantId, session);
  }

  /**
   * Sesiones que ya deberían tener asistencia pero no se han reconciliado.
   * Lo usa el worker: sesiones STARTED/ENDED cuya hora de fin (+ margen) ya
   * pasó, dentro de una ventana de 48h para no reintentar eternamente una
   * cuenta sin los scopes necesarios.
   */
  async listSessionsPendingAttendanceSync(
    now: Date,
    limit = 50,
  ): Promise<{ id: string; tenantId: string }[]> {
    const rows = await this.prisma.modZoomSession.findMany({
      where: {
        status: { in: ['STARTED', 'ENDED'] },
        attendanceSyncedAt: null,
        startTime: {
          gte: new Date(now.getTime() - 48 * 60 * 60 * 1000),
          lte: new Date(now.getTime() - GRACE_MINUTES * 60 * 1000),
        },
      },
      orderBy: { startTime: 'asc' },
      take: limit,
    });

    // El fin real (`startTime + duración + margen`) no es expresable en el
    // where de Prisma; filtramos aquí sobre un conjunto ya acotado.
    return rows.filter((r) => hasFinished(r, now)).map((r) => ({ id: r.id, tenantId: r.tenantId }));
  }

  async create(
    tenantId: string,
    actorId: string | null,
    dto: CreateSessionDto,
  ): Promise<SessionView> {
    if (dto.courseId) {
      const course = await this.prisma.modCoursesCourse.findFirst({
        where: { id: dto.courseId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!course) throw new CourseNotInTenantError(dto.courseId);
    }

    // lessonId requiere courseId y la lección debe pertenecer a ese curso.
    if (dto.lessonId) {
      if (!dto.courseId) throw new LessonNotInCourseError();
      const lesson = await this.prisma.modCoursesLesson.findFirst({
        where: {
          id: dto.lessonId,
          tenantId,
          deletedAt: null,
          module: { courseId: dto.courseId, deletedAt: null },
        },
        select: { id: true },
      });
      if (!lesson) throw new LessonNotInCourseError();
    }

    const api = await this.clientFor(tenantId);
    const meeting = await api.createMeeting({
      hostEmail: dto.hostEmail,
      topic: dto.topic,
      startTime: dto.startTime,
      durationMinutes: dto.durationMinutes,
      timezone: dto.timezone,
      description: dto.description,
    });

    const created = await this.prisma.modZoomSession.create({
      data: {
        id: randomUUID(),
        tenantId,
        courseId: dto.courseId ?? null,
        lessonId: dto.lessonId ?? null,
        topic: dto.topic,
        description: dto.description ?? null,
        status: 'SCHEDULED',
        startTime: new Date(dto.startTime),
        durationMinutes: dto.durationMinutes,
        timezone: dto.timezone,
        hostEmail: dto.hostEmail,
        zoomMeetingId: meeting.meetingId,
        joinUrl: meeting.joinUrl,
        startUrl: meeting.startUrl,
      },
    });

    await this.publish(tenantId, actorId, 'zoom.session.created', {
      sessionId: created.id,
      courseId: created.courseId,
      meetingId: meeting.meetingId,
    });
    this.ctx.logger.info('mod.zoom-live: session created', {
      tenantId,
      sessionId: created.id,
      meetingId: meeting.meetingId,
    });
    return this.toView(created, {
      includeStartUrl: true,
      includeJoinUrl: true,
      registeredCount: 0,
      isRegistered: false,
    });
  }

  async update(
    tenantId: string,
    actorId: string | null,
    sessionId: string,
    dto: UpdateSessionDto,
  ): Promise<SessionView> {
    const existing = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!existing) throw new SessionNotFoundError(sessionId);
    if (existing.status === 'ENDED' || existing.status === 'CANCELLED') {
      throw new SessionAlreadyEndedError();
    }

    if (existing.zoomMeetingId) {
      const api = await this.clientFor(tenantId);
      await api.updateMeeting(existing.zoomMeetingId, {
        ...(dto.topic !== undefined ? { topic: dto.topic } : {}),
        ...(dto.startTime !== undefined ? { startTime: dto.startTime } : {}),
        ...(dto.durationMinutes !== undefined ? { durationMinutes: dto.durationMinutes } : {}),
        // La timezone viaja SIEMPRE que cambie la hora, aunque el dto no la
        // traiga: Zoom interpreta las cifras de `start_time` en la timezone
        // del meeting, así que omitirla desplazaría la clase.
        ...(dto.timezone !== undefined
          ? { timezone: dto.timezone }
          : dto.startTime !== undefined
            ? { timezone: existing.timezone }
            : {}),
      });
    }

    const updated = await this.prisma.modZoomSession.update({
      where: { id: sessionId },
      data: {
        ...(dto.topic !== undefined ? { topic: dto.topic } : {}),
        ...(dto.startTime !== undefined ? { startTime: new Date(dto.startTime) } : {}),
        ...(dto.durationMinutes !== undefined ? { durationMinutes: dto.durationMinutes } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
      },
      include: { _count: { select: { registrations: true } } },
    });

    await this.publish(tenantId, actorId, 'zoom.session.updated', { sessionId });
    return this.toView(updated, {
      includeStartUrl: true,
      includeJoinUrl: true,
      registeredCount: updated._count.registrations,
      isRegistered: false,
    });
  }

  /**
   * Cancela una sesión (soft: marca `status = CANCELLED`, no borra row).
   * Pisa el meeting en Zoom para que ya no admita join.
   */
  async cancel(tenantId: string, actorId: string | null, sessionId: string): Promise<void> {
    const existing = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!existing) throw new SessionNotFoundError(sessionId);
    if (existing.status === 'CANCELLED') return; // idempotente
    if (existing.status === 'ENDED') throw new SessionAlreadyEndedError();

    if (existing.zoomMeetingId) {
      const api = await this.clientFor(tenantId);
      try {
        await api.deleteMeeting(existing.zoomMeetingId);
      } catch (e) {
        // Best-effort: si Zoom falla (404 por cancelación concurrente, caída
        // puntual…), cancelamos igualmente en Didacta — la BD es la fuente
        // de verdad y el meeting tiene waiting_room como red de seguridad.
        this.ctx.logger.warn('mod.zoom-live: deleteMeeting falló al cancelar; se cancela igual', {
          tenantId,
          sessionId,
          meetingId: existing.zoomMeetingId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Transición atómica: solo el request cuyo updateMany transiciona la fila
    // publica el evento. Sin esto, dos DELETE concurrentes (doble click del
    // admin) publicarían dos veces y el bridge duplicaría los avisos de
    // cancelación a todos los inscritos.
    const { count } = await this.prisma.modZoomSession.updateMany({
      where: { id: sessionId, tenantId, status: { notIn: ['CANCELLED', 'ENDED'] } },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) return; // otro request ganó la carrera — idempotente

    // Los inscritos van en el payload para que el bridge de notificaciones
    // pueda avisarles de la cancelación sin re-consultar el módulo. Se leen
    // DESPUÉS de ganar la transición para incluir a cualquier inscripción
    // que se colara justo antes del cambio de estado.
    const registrations = await this.prisma.modZoomSessionRegistration.findMany({
      where: { tenantId, sessionId },
      select: { userId: true },
    });

    await this.publish(tenantId, actorId, 'zoom.session.cancelled', {
      sessionId,
      topic: existing.topic,
      startTime: existing.startTime.toISOString(),
      timezone: existing.timezone,
      registeredUserIds: registrations.map((r) => r.userId),
    });
  }

  /**
   * Procesa un evento de webhook de Zoom (validación de firma ya hecha por
   * el controller). Devuelve el resultado de la operación:
   *  - `OK`: se aplicó un cambio de status.
   *  - `IGNORED`: evento conocido pero no relevante (no es started/ended,
   *    o el meeting no matchea ninguna sesión nuestra).
   *  - `DUPLICATE`: el `event_id` ya estaba procesado (Zoom reintenta).
   *  - `ERROR`: fallo al persistir; el controller responderá 5xx para que
   *    Zoom reintente.
   *
   * Es idempotente por `event_id`: registramos cada evento recibido en
   * `mod_zoom_webhook_event` con UNIQUE en esa columna; un segundo intento
   * con el mismo id devuelve DUPLICATE sin re-aplicar el efecto.
   */
  async handleWebhookEvent(
    event: ZoomWebhookEvent,
  ): Promise<{ result: 'OK' | 'IGNORED' | 'DUPLICATE' | 'ERROR'; sessionId?: string }> {
    // Idempotencia: el unique index en event_id rechaza duplicados.
    const existing = await this.prisma.modZoomWebhookEvent.findUnique({
      where: { eventId: event.event_id },
    });
    if (existing) {
      this.ctx.logger.info('mod.zoom-live: webhook duplicado, ignorado', {
        eventId: event.event_id,
        eventType: event.event,
      });
      return { result: 'DUPLICATE' };
    }

    const meetingId = event.payload?.object?.id ? String(event.payload.object.id) : null;
    const meetingUuid = event.payload?.object?.uuid ?? null;
    const session = meetingId
      ? await this.prisma.modZoomSession.findFirst({
          where: { zoomMeetingId: meetingId },
        })
      : null;

    let nextStatus: SessionStatus | null = null;
    if (event.event === 'meeting.started') nextStatus = 'STARTED';
    else if (event.event === 'meeting.ended') nextStatus = 'ENDED';

    const isRecordingCompleted = event.event === 'recording.completed';
    const shareUrl = event.payload?.object?.share_url ?? null;
    const recordingDurationMinutes =
      typeof event.payload?.object?.duration === 'number' ? event.payload.object.duration : null;

    let result: 'OK' | 'IGNORED' | 'ERROR' = 'OK';
    let errorMessage: string | undefined;

    if (!session) {
      // Sin sesión local no hay nada que actualizar; persistimos el evento
      // como IGNORED para trazabilidad.
      result = 'IGNORED';
    } else if (session.status === 'CANCELLED' && nextStatus) {
      // Una sesión cancelada no se resucita: un meeting.started reentregado
      // (o el host arrancando un meeting borrado a medias) la dejaría
      // STARTED y reabriría inscripciones. Trazabilidad sin efecto.
      result = 'IGNORED';
    } else if (nextStatus) {
      try {
        await this.prisma.modZoomSession.update({
          where: { id: session.id },
          data: {
            status: nextStatus,
            // Guardamos el UUID de la ocurrencia: es la clave con la que se
            // le piden los participantes a Zoom (ADR-018), y el id numérico
            // solo sirve para la última instancia de un recurrente.
            ...(meetingUuid ? { zoomMeetingUuid: meetingUuid } : {}),
          },
        });
        await this.publish(
          session.tenantId,
          null, // origen externo: no hay actorId
          nextStatus === 'STARTED' ? 'zoom.session.started' : 'zoom.session.ended',
          { sessionId: session.id, meetingId },
        );
      } catch (e) {
        result = 'ERROR';
        errorMessage = e instanceof Error ? e.message : String(e);
        this.ctx.logger.error('mod.zoom-live: error aplicando webhook', {
          eventId: event.event_id,
          eventType: event.event,
          error: errorMessage,
        });
      }
    } else if (isRecordingCompleted && shareUrl) {
      try {
        await this.prisma.modZoomSession.update({
          where: { id: session.id },
          data: {
            recordingUrl: shareUrl,
            recordingDurationMinutes,
          },
        });
        await this.publish(session.tenantId, null, 'zoom.session.recording_ready', {
          sessionId: session.id,
          meetingId,
          recordingUrl: shareUrl,
          recordingDurationMinutes,
        });
      } catch (e) {
        result = 'ERROR';
        errorMessage = e instanceof Error ? e.message : String(e);
        this.ctx.logger.error('mod.zoom-live: error guardando grabación', {
          eventId: event.event_id,
          eventType: event.event,
          error: errorMessage,
        });
      }
    } else {
      // Evento conocido pero sin efecto (ej. recording.completed sin
      // share_url, o meeting.participant_joined): trazabilidad sin acción.
      result = 'IGNORED';
    }

    await this.prisma.modZoomWebhookEvent.create({
      data: {
        id: randomUUID(),
        eventId: event.event_id,
        eventType: event.event,
        meetingId,
        sessionId: session?.id ?? null,
        tenantId: session?.tenantId ?? null,
        result,
        errorMessage: errorMessage ?? null,
      },
    });

    return { result, ...(session ? { sessionId: session.id } : {}) };
  }

  /**
   * Smoke test de credenciales Zoom S2S del tenant. Hace el OAuth
   * handshake real (sin tocar meetings) y devuelve el `accountId` echo
   * + un flag `kind` indicando si las credenciales son reales o el stub.
   * Lanza `ZoomApiError` (filtrado a 400 por error.filter) si Zoom
   * rechaza las creds.
   */
  async testCredentials(tenantId: string): Promise<{ kind: 'real' | 'stub'; accountId: string }> {
    const client = await this.clientFor(tenantId);
    const result = await client.testCredentials();
    const kind = client instanceof StubZoomApiClient ? 'stub' : 'real';
    return { kind, accountId: result.accountId };
  }

  /**
   * Lista paginada de eventos webhook recibidos para QA/debugging admin.
   * Filtros: `eventType` (exact match) y `result` (OK | IGNORED | ERROR).
   * Solo devuelve eventos que tienen `tenantId` resuelto (eventos sin
   * sesión asociada quedan con tenantId=null y se omiten para evitar
   * leaks cross-tenant).
   */
  async listWebhookEvents(
    tenantId: string,
    query: ListWebhookEventsQuery,
  ): Promise<PaginatedWebhookEvents> {
    const { eventType, result, page, limit } = query;
    const where = {
      tenantId,
      ...(eventType ? { eventType } : {}),
      ...(result ? { result } : {}),
    };
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.modZoomWebhookEvent.findMany({
        where,
        // Tiebreak por id DESC: dos webhooks pueden persistirse con
        // `received_at` idéntico al milisegundo (PostgreSQL TIMESTAMP(3)
        // tiene resolución 1ms y los inserts pueden caer dentro del
        // mismo tick). Sin tiebreak el orden no es determinístico y la
        // paginación puede saltar filas o duplicarlas.
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.modZoomWebhookEvent.count({ where }),
    ]);

    return {
      items: items.map(toWebhookEventView),
      total,
      page,
      limit,
    };
  }

  // ------------------- helpers -------------------

  /**
   * Une inscripciones y asistencia en un solo informe. Las filas son la
   * UNIÓN de ambas: un inscrito que no apareció sale con `attended: false`, y
   * un asistente que nunca se inscribió (entró por un enlace reenviado) sale
   * con `registered: false`. Ninguno de los dos debe desaparecer.
   */
  private async buildAttendanceReport(
    tenantId: string,
    session: {
      id: string;
      status: string;
      startTime: Date;
      durationMinutes: number;
      attendanceSyncedAt: Date | null;
      attendanceSyncError: string | null;
      zoomMeetingId: string | null;
      zoomMeetingUuid: string | null;
    },
  ): Promise<AttendanceReport> {
    const sessionId = session.id;
    const [registrations, attendances] = await Promise.all([
      this.prisma.modZoomSessionRegistration.findMany({
        where: { tenantId, sessionId },
        orderBy: { registeredAt: 'asc' },
      }),
      this.prisma.modZoomSessionAttendance.findMany({
        where: { tenantId, sessionId },
      }),
    ]);

    const userIds = [
      ...new Set([
        ...registrations.map((r) => r.userId),
        ...attendances.map((a) => a.userId).filter((id): id is string => Boolean(id)),
      ]),
    ];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { tenantId, id: { in: userIds } },
          select: { id: true, name: true, email: true, avatarUrl: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const registeredAtByUser = new Map(registrations.map((r) => [r.userId, r.registeredAt]));
    const attendanceByUser = new Map(
      attendances.filter((a) => a.userId).map((a) => [a.userId as string, a]),
    );

    const synced = session.attendanceSyncedAt !== null;
    const rows: AttendanceView[] = [];

    // 1. Miembros: todos los inscritos + los que asistieron sin inscribirse.
    const memberIds = [
      ...new Set([...registrations.map((r) => r.userId), ...attendanceByUser.keys()]),
    ];
    for (const userId of memberIds) {
      const att = attendanceByUser.get(userId);
      const user = userById.get(userId);
      const registeredAt = registeredAtByUser.get(userId) ?? null;
      rows.push({
        userId,
        name: user?.name ?? null,
        email: user?.email ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        registered: registeredAt !== null,
        registeredAt: registeredAt ? registeredAt.toISOString() : null,
        attended: computeAttended(att ?? null, synced),
        confidence: computeConfidence(att ?? null, synced),
        minutes: att?.minutes ?? 0,
        clickedJoinAt: att?.clickedJoinAt ? att.clickedJoinAt.toISOString() : null,
        joinedAt: att?.joinedAt ? att.joinedAt.toISOString() : null,
        leftAt: att?.leftAt ? att.leftAt.toISOString() : null,
        manualPresent: att?.manualPresent ?? null,
        zoomName: att?.zoomName ?? null,
        zoomEmail: att?.zoomEmail ?? null,
      });
    }

    // 2. Participantes de Zoom sin casar: se muestran para que el formador los
    //    reconozca, pero no cuentan como asistencia de ningún miembro.
    for (const att of attendances.filter((a) => !a.userId)) {
      rows.push({
        userId: null,
        name: null,
        email: null,
        avatarUrl: null,
        registered: false,
        registeredAt: null,
        attended: computeAttended(att, synced),
        confidence: computeConfidence(att, synced),
        minutes: att.minutes,
        clickedJoinAt: null,
        joinedAt: att.joinedAt ? att.joinedAt.toISOString() : null,
        leftAt: att.leftAt ? att.leftAt.toISOString() : null,
        manualPresent: att.manualPresent,
        zoomName: att.zoomName,
        zoomEmail: att.zoomEmail,
      });
    }

    // Orden: asistentes primero (más minutos arriba), luego ausentes, y al
    // final los que no casan con ningún miembro.
    rows.sort((a, b) => {
      if (!a.userId !== !b.userId) return a.userId ? -1 : 1;
      if (a.attended !== b.attended) return a.attended ? -1 : 1;
      if (b.minutes !== a.minutes) return b.minutes - a.minutes;
      return (a.name ?? a.email ?? a.zoomName ?? '').localeCompare(
        b.name ?? b.email ?? b.zoomName ?? '',
      );
    });

    return {
      sessionId,
      status: session.status as SessionStatus,
      syncedAt: session.attendanceSyncedAt ? session.attendanceSyncedAt.toISOString() : null,
      syncError: session.attendanceSyncError,
      canSync:
        (session.status === 'ENDED' ||
          (session.status === 'STARTED' && hasFinished(session, new Date()))) &&
        Boolean(session.zoomMeetingUuid ?? session.zoomMeetingId),
      registeredCount: registrations.length,
      attendedCount: rows.filter((r) => r.attended).length,
      rows,
    };
  }

  /**
   * Casa participantes de Zoom con miembros del tenant por email. Zoom
   * devuelve el email tal cual lo tenga la cuenta, así que comparamos en
   * minúsculas; consultamos ambas variantes porque no asumimos cómo están
   * normalizados los emails en `user`.
   */
  private async matchParticipantsToUsers(
    tenantId: string,
    entries: AggregatedParticipant[],
  ): Promise<Map<string, string>> {
    const emails = entries.map((e) => e.email).filter((e): e is string => Boolean(e));
    if (emails.length === 0) return new Map();

    const variants = [...new Set(emails.flatMap((e) => [e, e.toLowerCase()]))];
    const users = await this.prisma.user.findMany({
      where: { tenantId, email: { in: variants } },
      select: { id: true, email: true },
    });
    const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

    const out = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.email) continue;
      const userId = userByEmail.get(entry.email.toLowerCase());
      if (userId) out.set(entry.key, userId);
    }
    return out;
  }

  /**
   * Busca la fila de un participante sin casar para no duplicarla al
   * re-sincronizar. La clave es el `participantId` de Zoom; si no vino,
   * caemos al email y luego al nombre.
   */
  private async findUnmatchedAttendance(
    tenantId: string,
    sessionId: string,
    entry: AggregatedParticipant,
  ): Promise<{ id: string } | null> {
    const rows = await this.prisma.modZoomSessionAttendance.findMany({
      where: { tenantId, sessionId, userId: null },
    });
    return (
      rows.find((r) =>
        entry.participantId
          ? r.zoomParticipantId === entry.participantId
          : entry.email
            ? r.zoomEmail === entry.email
            : r.zoomName === entry.name,
      ) ?? null
    );
  }

  /**
   * Set de sessionIds (dentro de `candidateIds`) en los que el viewer
   * está inscrito. Sin viewer devuelve set vacío (viewer anónimo/sistema).
   */
  private async registeredSessionIds(
    tenantId: string,
    viewer: SessionViewer | undefined,
    candidateIds: string[],
  ): Promise<Set<string>> {
    if (!viewer || candidateIds.length === 0) return new Set();
    const rows = await this.prisma.modZoomSessionRegistration.findMany({
      where: { tenantId, userId: viewer.userId, sessionId: { in: candidateIds } },
      select: { sessionId: true },
    });
    return new Set(rows.map((r) => r.sessionId));
  }

  private async publish(
    tenantId: string,
    actorId: string | null,
    name: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.ctx.eventBus.publish({
      name,
      version: 1,
      data,
      metadata: {
        tenantId,
        userId: actorId ?? undefined,
        timestamp: new Date().toISOString(),
        traceId: randomUUID(),
        idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,
      },
    });
  }

  private toView(
    row: {
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
    },
    opts: {
      includeStartUrl: boolean;
      /** ADR-017: false → joinUrl y recordingUrl se serializan como NULL. */
      includeJoinUrl: boolean;
      registeredCount: number;
      isRegistered: boolean;
    },
  ): SessionView {
    return {
      id: row.id,
      tenantId: row.tenantId,
      courseId: row.courseId,
      lessonId: row.lessonId,
      topic: row.topic,
      description: row.description,
      status: row.status as SessionStatus,
      startTime: row.startTime.toISOString(),
      durationMinutes: row.durationMinutes,
      timezone: row.timezone,
      hostEmail: row.hostEmail,
      zoomMeetingId: row.zoomMeetingId,
      joinUrl: opts.includeJoinUrl ? row.joinUrl : null,
      ...(opts.includeStartUrl ? { startUrl: row.startUrl } : {}),
      recordingUrl: opts.includeJoinUrl ? row.recordingUrl : null,
      recordingDurationMinutes: row.recordingDurationMinutes,
      registeredCount: opts.registeredCount,
      isRegistered: opts.isRegistered,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * Margen tras el fin teórico de la clase antes de pedirle los participantes a
 * Zoom: el meeting puede alargarse y el informe tarda un poco en cuajar.
 */
const GRACE_MINUTES = 15;

/**
 * ¿Ya pasó la hora de fin teórica (+ margen) de la sesión? Es lo que decide
 * si tiene sentido pedirle los participantes a Zoom: hacerlo antes devolvería
 * una foto parcial que además sellaría la sesión como reconciliada.
 */
function hasFinished(session: { startTime: Date; durationMinutes: number }, now: Date): boolean {
  const endsAt =
    session.startTime.getTime() + (session.durationMinutes + GRACE_MINUTES) * 60 * 1000;
  return endsAt <= now.getTime();
}

interface AggregatedParticipant {
  /** Clave de agregación (email, o id de participante, o nombre). */
  key: string;
  participantId: string | null;
  name: string | null;
  email: string | null;
  minutes: number;
  joinedAt: Date | null;
  leftAt: Date | null;
}

/**
 * Agrupa las entradas de Zoom por persona. Zoom emite una entrada por tramo
 * de conexión: quien se cae y vuelve aparece varias veces y hay que sumar sus
 * minutos, o un alumno con mala línea parecería no haber asistido.
 *
 * Los minutos se calculan de `leave - join` cuando hay ambos timestamps (es
 * lo que un humano llamaría "tiempo en clase") y solo caemos a `duration`
 * —que Zoom reporta en segundos— si falta alguno.
 */
function aggregateParticipants(participants: ZoomParticipantRecord[]): AggregatedParticipant[] {
  const byKey = new Map<string, AggregatedParticipant>();

  for (const p of participants) {
    const key = (p.email ?? p.participantId ?? p.name ?? '').toLowerCase();
    if (!key) continue; // entrada sin ninguna identidad: no hay nada que casar

    const join = p.joinTime ? new Date(p.joinTime) : null;
    const leave = p.leaveTime ? new Date(p.leaveTime) : null;
    const validJoin = join && !Number.isNaN(join.getTime()) ? join : null;
    const validLeave = leave && !Number.isNaN(leave.getTime()) ? leave : null;

    let minutes = 0;
    if (validJoin && validLeave && validLeave > validJoin) {
      minutes = Math.round((validLeave.getTime() - validJoin.getTime()) / 60_000);
    } else if (p.durationSeconds !== null) {
      minutes = Math.round(p.durationSeconds / 60);
    }

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        key,
        participantId: p.participantId,
        name: p.name,
        email: p.email,
        minutes,
        joinedAt: validJoin,
        leftAt: validLeave,
      });
      continue;
    }

    prev.minutes += minutes;
    prev.participantId ??= p.participantId;
    prev.name ??= p.name;
    prev.email ??= p.email;
    if (validJoin && (!prev.joinedAt || validJoin < prev.joinedAt)) prev.joinedAt = validJoin;
    if (validLeave && (!prev.leftAt || validLeave > prev.leftAt)) prev.leftAt = validLeave;
  }

  return [...byKey.values()];
}

/** Fila de asistencia mínima que necesitan los cálculos derivados. */
interface AttendanceFacts {
  present: boolean;
  clickedJoinAt: Date | null;
  manualPresent: boolean | null;
}

/**
 * ¿Asistió? El override manual manda. Si no, vale lo que diga Zoom; y solo
 * mientras la sesión NO se ha reconciliado aceptamos el click como evidencia
 * — una vez Zoom ha hablado, un click sin presencia significa que abrió el
 * enlace y no entró.
 */
function computeAttended(att: AttendanceFacts | null, synced: boolean): boolean {
  if (!att) return false;
  if (att.manualPresent !== null) return att.manualPresent;
  if (att.present) return true;
  return !synced && att.clickedJoinAt !== null;
}

/** De dónde sale el `attended` que acabamos de calcular. */
function computeConfidence(att: AttendanceFacts | null, synced: boolean): AttendanceConfidence {
  if (att?.manualPresent != null) return 'MANUAL';
  if (synced) return 'ZOOM';
  if (att?.clickedJoinAt) return 'PROXY';
  return 'NONE';
}

function toWebhookEventView(row: {
  id: string;
  eventId: string;
  eventType: string;
  meetingId: string | null;
  sessionId: string | null;
  receivedAt: Date;
  result: string;
  errorMessage: string | null;
}): WebhookEventView {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    meetingId: row.meetingId,
    sessionId: row.sessionId,
    receivedAt: row.receivedAt.toISOString(),
    result: row.result as 'OK' | 'IGNORED' | 'ERROR',
    errorMessage: row.errorMessage,
  };
}
