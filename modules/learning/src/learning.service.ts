import { randomBytes, randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  AlreadyEnrolledError,
  CourseNotPublishedError,
  EnrollmentNotFoundError,
  InvitationInvalidError,
} from './errors.js';
import type {
  CreateInvitationDto,
  EnrollByAdminDto,
  EnrollByCodeDto,
  EnrollByLinkDto,
  TrackProgressDto,
} from './dto.js';

const TOKEN_BYTES = 24;
const CODE_GROUPS = 2;
const CODE_GROUP_LEN = 4;

export class LearningService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  /**
   * Acepta la matriculación si el curso está publicado.
   * Idempotente: si ya hay enrollment activo para (tenant, user, course), devuelve el existente.
   */
  async enrollByAdmin(tenantId: string, actorId: string | null, dto: EnrollByAdminDto) {
    return this.createEnrollment({
      tenantId,
      actorId,
      userId: dto.userId,
      courseId: dto.courseId,
      source: 'ADMIN',
    });
  }

  async enrollByCode(tenantId: string, userId: string, dto: EnrollByCodeDto) {
    const invitation = await this.requireUsableInvitationByCode(tenantId, dto.code);
    return this.createFromInvitation(tenantId, userId, invitation, 'CODE');
  }

  async enrollByLink(tenantId: string, userId: string, dto: EnrollByLinkDto) {
    const invitation = await this.requireUsableInvitationByToken(tenantId, dto.token);
    return this.createFromInvitation(tenantId, userId, invitation, 'INVITATION_LINK');
  }

  /**
   * El alumno se matricula a sí mismo en un curso PUBLISHED del tenant.
   * No requiere código ni link — útil cuando el formador deja el curso open-enrollment.
   */
  async enrollSelf(tenantId: string, userId: string, courseId: string) {
    return this.createEnrollment({
      tenantId,
      actorId: userId,
      userId,
      courseId,
      source: 'ADMIN',
    });
  }

  async listInvitationsForCourse(tenantId: string, courseId: string) {
    return this.prisma.modLearningInvitation.findMany({
      where: { tenantId, courseId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeInvitation(tenantId: string, invitationId: string) {
    await this.prisma.modLearningInvitation.updateMany({
      where: { id: invitationId, tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async trackProgress(tenantId: string, userId: string, dto: TrackProgressDto) {
    const enrollment = await this.prisma.modLearningEnrollment.findFirst({
      where: { tenantId, userId, id: dto.enrollmentId },
    });
    if (!enrollment) throw new EnrollmentNotFoundError();

    const updated = await this.prisma.modLearningProgress.upsert({
      where: {
        enrollmentId_lessonId: { enrollmentId: dto.enrollmentId, lessonId: dto.lessonId },
      },
      create: {
        tenantId,
        enrollmentId: dto.enrollmentId,
        lessonId: dto.lessonId,
        watchedSeconds: dto.watchedSeconds,
        resumePositionSec: dto.resumePositionSec ?? 0,
        completed: dto.completed ?? false,
        completedAt: dto.completed ? new Date() : null,
      },
      update: {
        watchedSeconds: { increment: Math.max(0, dto.watchedSeconds) },
        resumePositionSec: dto.resumePositionSec ?? undefined,
        completed: dto.completed ?? undefined,
        completedAt: dto.completed ? new Date() : undefined,
      },
    });

    const totals = await this.recalcEnrollmentProgress(enrollment.id, enrollment.tenantId);
    await this.publish(tenantId, userId, 'learning.progress.updated', {
      enrollmentId: enrollment.id,
      lessonId: dto.lessonId,
      progressPercent: totals.progressPercent,
    });

    if (
      totals.progressPercent >= enrollment.completionThreshold &&
      enrollment.completedAt === null
    ) {
      await this.prisma.modLearningEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          progressPercent: totals.progressPercent,
        },
      });
      await this.publish(tenantId, userId, 'learning.course.completed', {
        enrollmentId: enrollment.id,
        courseId: enrollment.courseId,
        userId,
      });
    }

    return { progress: updated, ...totals };
  }

  async listMyEnrollments(tenantId: string, userId: string) {
    return this.prisma.modLearningEnrollment.findMany({
      where: { tenantId, userId },
      orderBy: { enrolledAt: 'desc' },
    });
  }

  /**
   * Devuelve el progreso por lección de UNA matriculación del usuario.
   * Lo usa el player del curso para hidratar qué lecciones ya completó
   * el alumno al cargar la página (evita que vuelva a marcarlas como
   * "no completadas" tras un refresh).
   */
  async listMyProgress(tenantId: string, userId: string, enrollmentId: string) {
    const enrollment = await this.prisma.modLearningEnrollment.findFirst({
      where: { tenantId, userId, id: enrollmentId },
      select: { id: true },
    });
    if (!enrollment) throw new EnrollmentNotFoundError();
    return this.prisma.modLearningProgress.findMany({
      where: { tenantId, enrollmentId },
      select: {
        lessonId: true,
        completed: true,
        watchedSeconds: true,
        resumePositionSec: true,
        completedAt: true,
      },
    });
  }

  /**
   * HU-FORM-002: lista de matriculaciones de un curso (vista del formador
   * para ver alumnos).
   *
   * Devuelve enrollments + datos del usuario (email, name, lastLoginAt).
   * NO hace cross-module FK — la consulta join-like se hace acá leyendo
   * usuarios por IDs lógicos.
   */
  async listEnrollmentsByCourse(
    tenantId: string,
    courseId: string,
    options: { status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'; limit?: number } = {},
  ) {
    const where: Record<string, unknown> = { tenantId, courseId };
    if (options.status) where.status = options.status;

    const enrollments = await this.prisma.modLearningEnrollment.findMany({
      where,
      orderBy: { enrolledAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    });

    if (enrollments.length === 0) return [];

    const userIds = Array.from(new Set(enrollments.map((e) => e.userId)));
    const users = await this.prisma.user.findMany({
      where: { tenantId, id: { in: userIds } },
      select: { id: true, email: true, name: true, lastLoginAt: true, status: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    return enrollments.map((e) => {
      const u = byId.get(e.userId);
      return {
        enrollmentId: e.id,
        userId: e.userId,
        userEmail: u?.email ?? null,
        userName: u?.name ?? null,
        userStatus: u?.status ?? null,
        lastLoginAt: u?.lastLoginAt?.toISOString() ?? null,
        status: e.status,
        progressPercent: e.progressPercent,
        enrolledAt: e.enrolledAt.toISOString(),
        completedAt: e.completedAt?.toISOString() ?? null,
        completionThreshold: e.completionThreshold,
      };
    });
  }

  async createInvitation(tenantId: string, actorId: string | null, dto: CreateInvitationDto) {
    const code = this.generateCode();
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const invitation = await this.prisma.modLearningInvitation.create({
      data: {
        tenantId,
        courseId: dto.courseId,
        code,
        token,
        maxUses: dto.maxUses ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdById: actorId,
      },
    });
    await this.publish(tenantId, actorId, 'learning.invitation.created', {
      invitationId: invitation.id,
      courseId: dto.courseId,
    });
    return invitation;
  }

  async cancelEnrollment(tenantId: string, userId: string, enrollmentId: string) {
    const existing = await this.prisma.modLearningEnrollment.findFirst({
      where: { tenantId, id: enrollmentId, userId },
    });
    if (!existing) throw new EnrollmentNotFoundError();
    if (existing.status === 'CANCELLED') return existing;

    const updated = await this.prisma.modLearningEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await this.publish(tenantId, userId, 'learning.enrollment.cancelled', {
      enrollmentId,
    });
    return updated;
  }

  // ---------------------- helpers privados ----------------------

  private async createEnrollment(params: {
    tenantId: string;
    actorId: string | null;
    userId: string;
    courseId: string;
    source: 'ADMIN' | 'CODE' | 'INVITATION_LINK' | 'PURCHASE' | 'IMPORT';
  }) {
    await this.requirePublishedCourse(params.tenantId, params.courseId);

    const existing = await this.prisma.modLearningEnrollment.findFirst({
      where: {
        tenantId: params.tenantId,
        userId: params.userId,
        courseId: params.courseId,
      },
    });
    if (existing && existing.status === 'ACTIVE') {
      throw new AlreadyEnrolledError();
    }

    const enrollment = await this.prisma.modLearningEnrollment.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        courseId: params.courseId,
        source: params.source,
      },
    });

    await this.publish(params.tenantId, params.actorId, 'learning.enrollment.created', {
      enrollmentId: enrollment.id,
      userId: params.userId,
      courseId: params.courseId,
      source: params.source,
    });
    return enrollment;
  }

  private async createFromInvitation(
    tenantId: string,
    userId: string,
    invitation: { id: string; courseId: string; usedCount: number },
    source: 'CODE' | 'INVITATION_LINK',
  ) {
    const enrollment = await this.createEnrollment({
      tenantId,
      actorId: userId,
      userId,
      courseId: invitation.courseId,
      source,
    });
    await this.prisma.modLearningInvitation.update({
      where: { id: invitation.id },
      data: { usedCount: invitation.usedCount + 1 },
    });
    return enrollment;
  }

  private async requirePublishedCourse(tenantId: string, courseId: string) {
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, id: courseId, deletedAt: null },
    });
    if (!course) throw new CourseNotPublishedError();
    if (course.status !== 'PUBLISHED') throw new CourseNotPublishedError();
    return course;
  }

  private async requireUsableInvitationByCode(tenantId: string, code: string) {
    const invitation = await this.prisma.modLearningInvitation.findUnique({
      where: { tenantId_code: { tenantId, code: code.toUpperCase() } },
    });
    if (!invitation) throw new InvitationInvalidError('código no encontrado');
    return this.assertInvitationUsable(invitation);
  }

  private async requireUsableInvitationByToken(tenantId: string, token: string) {
    const invitation = await this.prisma.modLearningInvitation.findUnique({ where: { token } });
    if (!invitation || invitation.tenantId !== tenantId) {
      throw new InvitationInvalidError('token inválido');
    }
    return this.assertInvitationUsable(invitation);
  }

  private assertInvitationUsable(invitation: {
    id: string;
    courseId: string;
    usedCount: number;
    maxUses: number | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  }) {
    if (invitation.revokedAt) throw new InvitationInvalidError('revocada');
    if (invitation.expiresAt && invitation.expiresAt.getTime() < Date.now()) {
      throw new InvitationInvalidError('expirada');
    }
    if (invitation.maxUses !== null && invitation.usedCount >= invitation.maxUses) {
      throw new InvitationInvalidError('agotada');
    }
    return invitation;
  }

  private async recalcEnrollmentProgress(enrollmentId: string, tenantId: string) {
    const enrollment = await this.prisma.modLearningEnrollment.findUniqueOrThrow({
      where: { id: enrollmentId },
    });
    const totalLessons = await this.prisma.modCoursesLesson.count({
      where: { tenantId, module: { courseId: enrollment.courseId }, deletedAt: null },
    });
    const completedLessons = await this.prisma.modLearningProgress.count({
      where: { tenantId, enrollmentId, completed: true },
    });
    const progressPercent =
      totalLessons === 0 ? 0 : Math.round((completedLessons / totalLessons) * 100);
    await this.prisma.modLearningEnrollment.update({
      where: { id: enrollmentId },
      data: { progressPercent, startedAt: enrollment.startedAt ?? new Date() },
    });
    return { totalLessons, completedLessons, progressPercent };
  }

  private generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const groups: string[] = [];
    const bytes = randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
    for (let g = 0; g < CODE_GROUPS; g++) {
      let group = '';
      for (let i = 0; i < CODE_GROUP_LEN; i++) {
        const idx = bytes[g * CODE_GROUP_LEN + i] ?? 0;
        group += chars[idx % chars.length];
      }
      groups.push(group);
    }
    return groups.join('-');
  }

  private async publish(
    tenantId: string,
    actorId: string | null,
    name: string,
    data: Record<string, unknown>,
  ) {
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
}
