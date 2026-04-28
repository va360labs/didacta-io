import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  type CreateSessionDto,
  type ListWebhookEventsQuery,
  type PaginatedWebhookEvents,
  type SessionView,
  type UpdateSessionDto,
  type SessionStatus,
  type WebhookEventView,
  type ZoomWebhookEvent,
} from './dto.js';
import {
  CourseNotInTenantError,
  LessonNotInCourseError,
  SessionAlreadyEndedError,
  SessionNotFoundError,
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

  async list(
    tenantId: string,
    opts: { courseId?: string; lessonId?: string; status?: SessionStatus } = {},
  ): Promise<SessionView[]> {
    const rows = await this.prisma.modZoomSession.findMany({
      where: {
        tenantId,
        ...(opts.courseId ? { courseId: opts.courseId } : {}),
        ...(opts.lessonId ? { lessonId: opts.lessonId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { startTime: 'desc' },
    });
    return rows.map((r) => this.toView(r, { includeStartUrl: false }));
  }

  async get(tenantId: string, sessionId: string): Promise<SessionView> {
    const row = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!row) throw new SessionNotFoundError(sessionId);
    return this.toView(row, { includeStartUrl: false });
  }

  /**
   * Variante que incluye `startUrl` — solo para el host o admins. La
   * separación a nivel de método obliga al controller a decidir
   * explícitamente quién puede ver la URL de inicio.
   */
  async getForHost(tenantId: string, sessionId: string): Promise<SessionView> {
    const row = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!row) throw new SessionNotFoundError(sessionId);
    return this.toView(row, { includeStartUrl: true });
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
    return this.toView(created, { includeStartUrl: true });
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
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
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
    });

    await this.publish(tenantId, actorId, 'zoom.session.updated', { sessionId });
    return this.toView(updated, { includeStartUrl: true });
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
      await api.deleteMeeting(existing.zoomMeetingId);
    }

    await this.prisma.modZoomSession.update({
      where: { id: sessionId },
      data: { status: 'CANCELLED' },
    });

    await this.publish(tenantId, actorId, 'zoom.session.cancelled', { sessionId });
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
    } else if (nextStatus) {
      try {
        await this.prisma.modZoomSession.update({
          where: { id: session.id },
          data: { status: nextStatus },
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
        orderBy: { receivedAt: 'desc' },
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
    opts: { includeStartUrl: boolean },
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
      joinUrl: row.joinUrl,
      ...(opts.includeStartUrl ? { startUrl: row.startUrl } : {}),
      recordingUrl: row.recordingUrl,
      recordingDurationMinutes: row.recordingDurationMinutes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
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
