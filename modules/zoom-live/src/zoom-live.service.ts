import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  type CreateSessionDto,
  type SessionView,
  type UpdateSessionDto,
  type SessionStatus,
} from './dto.js';
import {
  CourseNotInTenantError,
  LessonNotInCourseError,
  SessionAlreadyEndedError,
  SessionNotFoundError,
} from './errors.js';
import { StubZoomApiClient, type ZoomApiClient } from './zoom-api-client.js';

export class ZoomLiveService {
  private readonly api: ZoomApiClient;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
    /**
     * Cliente Zoom inyectable. En prod vendrá de un factory que lee
     * `tenant_settings` y construye `RealZoomApiClient` por tenant. En dev
     * y tests usamos el stub determinístico.
     */
    api?: ZoomApiClient,
  ) {
    this.api = api ?? new StubZoomApiClient();
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

    const meeting = await this.api.createMeeting({
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
      await this.api.updateMeeting(existing.zoomMeetingId, {
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
      await this.api.deleteMeeting(existing.zoomMeetingId);
    }

    await this.prisma.modZoomSession.update({
      where: { id: sessionId },
      data: { status: 'CANCELLED' },
    });

    await this.publish(tenantId, actorId, 'zoom.session.cancelled', { sessionId });
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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
