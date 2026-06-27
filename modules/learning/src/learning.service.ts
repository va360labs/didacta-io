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

/**
 * Tipo de lección (mismo dominio que el enum `LessonType` de Prisma). Se declara
 * aquí como unión de literales para no acoplar el módulo a `@prisma/client`
 * directamente (la dependencia de Prisma vive encapsulada en `@didacta/database`).
 */
export type LessonType = 'VIDEO' | 'HTML' | 'PDF' | 'TEXT' | 'QUIZ' | 'SCORM';

/**
 * Detalle del progreso de UN alumno en UN curso, lección a lección. Es la vista
 * del formador/admin: agrupa las lecciones del curso por módulo y, para cada una,
 * el tiempo visto y el estado de finalización del alumno. Las lecciones nunca
 * empezadas aparecen igualmente en 0 (left-join contra el progreso real).
 */
export interface EnrollmentProgressDetail {
  enrollmentId: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED';
  progressPercent: number;
  totalWatchedSeconds: number;
  lessonsCompleted: number;
  lessonsTotal: number;
  modules: Array<{
    moduleId: string;
    moduleTitle: string;
    lessons: Array<{
      lessonId: string;
      lessonTitle: string;
      type: LessonType;
      durationMinutes: number | null;
      watchedSeconds: number;
      resumePositionSec: number;
      completed: boolean;
      completedAt: string | null;
      lastAccessedAt: string | null;
    }>;
  }>;
}

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

  /**
   * Matriculación tras pago confirmado por mod.billing. Source `PURCHASE`
   * la diferencia de admin/código en audit y reporting comercial.
   * Idempotente desde la perspectiva del bridge: si el alumno ya tenía
   * enrollment ACTIVE (webhook duplicado), `createEnrollment` lanza
   * `AlreadyEnrolledError`, que el bridge captura como no-op.
   */
  async enrollFromPurchase(tenantId: string, userId: string, courseId: string) {
    return this.createEnrollment({
      tenantId,
      actorId: null,
      userId,
      courseId,
      source: 'PURCHASE',
    });
  }

  /**
   * Matriculación tras suscripción Stripe activa (mod.subscriptions). Source
   * `SUBSCRIPTION` la diferencia de pago único en audit y reporting comercial.
   *
   * Idempotencia: si el alumno ya está enrolled (recovery desde PAST_DUE),
   * `createEnrollment` lanza `AlreadyEnrolledError`. El bridge la captura y
   * llama a `resumeEnrollment` por si estaba PAUSED.
   */
  async enrollFromSubscription(tenantId: string, userId: string, courseId: string) {
    return this.createEnrollment({
      tenantId,
      actorId: null,
      userId,
      courseId,
      source: 'SUBSCRIPTION',
    });
  }

  /**
   * Matriculación creada por un sistema externo (página de ventas de terceros)
   * vía `POST /api/v1/inscribe` autenticado con API key. Source `API` la
   * diferencia en audit y reporting comercial.
   *
   * Idempotente: si el alumno ya tiene enrollment ACTIVE (la pasarela reintenta
   * el webhook de compra), `createEnrollment` lanza `AlreadyEnrolledError`, que
   * el caller (`InscribeService`) captura como no-op.
   */
  async enrollFromApi(tenantId: string, userId: string, courseId: string) {
    return this.createEnrollment({
      tenantId,
      actorId: userId,
      userId,
      courseId,
      source: 'API',
    });
  }

  /**
   * Pausa el enrollment de un alumno en un curso. Lo invoca el bridge de
   * mod.subscriptions cuando la suscripción entra en UNPAID (grace expirado).
   *
   * NO toca progreso ni lecciones completadas. Si vuelve a estar ACTIVE,
   * `resumeEnrollment` reactiva sin perder nada.
   *
   * No lanza si no hay enrollment activo (puede haber sido cancelado por otra
   * vía); en ese caso, no-op.
   */
  async pauseEnrollment(tenantId: string, userId: string, courseId: string): Promise<void> {
    await this.prisma.modLearningEnrollment.updateMany({
      where: { tenantId, userId, courseId, status: 'ACTIVE' },
      data: { status: 'PAUSED' },
    });
    await this.publish(tenantId, userId, 'learning.enrollment.paused', { courseId, userId });
  }

  /**
   * Reanuda enrollments PAUSED. Lo invoca el bridge tras recovery desde
   * PAST_DUE/UNPAID a ACTIVE.
   *
   * No-op si no hay PAUSED (puede que ya esté ACTIVE o COMPLETED).
   */
  async resumeEnrollment(tenantId: string, userId: string, courseId: string): Promise<void> {
    await this.prisma.modLearningEnrollment.updateMany({
      where: { tenantId, userId, courseId, status: 'PAUSED' },
      data: { status: 'ACTIVE' },
    });
    await this.publish(tenantId, userId, 'learning.enrollment.resumed', { courseId, userId });
  }

  /**
   * Cancela el enrollment activo o pausado tras cancelación inmediata de
   * suscripción (immediate=true en cancelSubscription, o subscription.deleted
   * en Stripe). NO se conservan ni progreso ni datos personales más allá de
   * lo que ya esté en audit.
   *
   * Si el alumno vuelve a suscribirse, se crea un enrollment nuevo (no se
   * reactiva uno cancelado).
   */
  async unenrollFromSubscription(
    tenantId: string,
    userId: string,
    courseId: string,
  ): Promise<void> {
    await this.prisma.modLearningEnrollment.updateMany({
      where: {
        tenantId,
        userId,
        courseId,
        status: { in: ['ACTIVE', 'PAUSED'] },
        source: 'SUBSCRIPTION',
      },
      data: { status: 'CANCELLED' },
    });
    await this.publish(tenantId, userId, 'learning.enrollment.cancelled', { courseId, userId });
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
   * Estadísticas de aprendizaje del usuario para el perfil ("Mi perfil"):
   * cursos completados y segundos totales de visionado real (suma de
   * `watchedSeconds` de su progreso). Las horas las redondea el frontend.
   */
  async getMyStats(
    tenantId: string,
    userId: string,
  ): Promise<{ completedCourses: number; trainingSeconds: number }> {
    const enrollments = await this.prisma.modLearningEnrollment.findMany({
      where: { tenantId, userId },
      select: { id: true, status: true },
    });
    const completedCourses = enrollments.filter((e) => e.status === 'COMPLETED').length;
    const enrollmentIds = enrollments.map((e) => e.id);
    let trainingSeconds = 0;
    if (enrollmentIds.length > 0) {
      const agg = await this.prisma.modLearningProgress.aggregate({
        where: { tenantId, enrollmentId: { in: enrollmentIds } },
        _sum: { watchedSeconds: true },
      });
      trainingSeconds = agg._sum.watchedSeconds ?? 0;
    }
    return { completedCourses, trainingSeconds };
  }

  // -------------------- Competencias (derivadas de cursos) --------------------

  /**
   * Mapa de competencias del usuario, DERIVADO de cursos: el score 0-100 de
   * cada competencia es la media de `progressPercent` de las matrículas del
   * usuario en los cursos asociados a esa competencia, ponderada por `weight`.
   * Competencias sin cursos cursados por el usuario se omiten (no se inventan).
   */
  async getMyCompetencies(
    tenantId: string,
    userId: string,
  ): Promise<{
    competencies: Array<{ id: string; name: string; score: number }>;
    globalScore: number | null;
    globalLevel: string | null;
  }> {
    const [competencies, mappings, enrollments] = await Promise.all([
      this.prisma.modLearningCompetency.findMany({
        where: { tenantId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.modLearningCourseCompetency.findMany({ where: { tenantId } }),
      this.prisma.modLearningEnrollment.findMany({
        where: { tenantId, userId },
        select: { courseId: true, progressPercent: true },
      }),
    ]);

    const progressByCourse = new Map(enrollments.map((e) => [e.courseId, e.progressPercent]));
    return computeCompetencyScores(competencies, mappings, progressByCourse);
  }

  async listCompetencies(tenantId: string) {
    return this.prisma.modLearningCompetency.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createCompetency(
    tenantId: string,
    input: { name: string; description?: string | null; sortOrder?: number },
  ) {
    return this.prisma.modLearningCompetency.create({
      data: {
        tenantId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        sortOrder: input.sortOrder ?? 0,
      },
    });
  }

  async deleteCompetency(tenantId: string, id: string) {
    await this.prisma.modLearningCompetency.deleteMany({ where: { tenantId, id } });
    return { ok: true as const };
  }

  async getCourseCompetencies(tenantId: string, courseId: string) {
    const rows = await this.prisma.modLearningCourseCompetency.findMany({
      where: { tenantId, courseId },
      include: { competency: { select: { id: true, name: true } } },
    });
    return rows.map((r) => ({
      competencyId: r.competencyId,
      name: r.competency.name,
      weight: r.weight,
    }));
  }

  /** Reemplaza el set de competencias de un curso (borra + recrea). */
  async setCourseCompetencies(
    tenantId: string,
    courseId: string,
    items: Array<{ competencyId: string; weight?: number }>,
  ) {
    await this.prisma.$transaction([
      this.prisma.modLearningCourseCompetency.deleteMany({ where: { tenantId, courseId } }),
      ...items.map((it) =>
        this.prisma.modLearningCourseCompetency.create({
          data: {
            tenantId,
            courseId,
            competencyId: it.competencyId,
            weight: Math.max(1, it.weight ?? 1),
          },
        }),
      ),
    ]);
    return this.getCourseCompetencies(tenantId, courseId);
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

  // -------------------- Comentarios en lecciones --------------------

  /**
   * Crea un comentario del alumno en una lección. Llega siempre en
   * estado PENDING; el profesor del curso lo aprueba o rechaza antes
   * de que sea visible al resto. El autor siempre ve los suyos
   * (incluyendo PENDING) para que entienda que están en moderación.
   */
  async createLessonComment(
    tenantId: string,
    author: { id: string; displayName: string | null },
    input: { lessonId: string; courseId: string; body: string },
  ) {
    return this.prisma.modLearningLessonComment.create({
      data: {
        tenantId,
        lessonId: input.lessonId,
        courseId: input.courseId,
        authorId: author.id,
        authorDisplayName: author.displayName,
        body: input.body.trim(),
      },
    });
  }

  /**
   * Lista los comentarios visibles para el viewer en una lección:
   * los APPROVED de cualquier autor, más los PENDING/REJECTED del
   * propio viewer (para que vea el estado de su moderación).
   *
   * Si el viewer es el formador del curso (o admin), también ve los
   * PENDING de otros — eso lo decide el caller pasando `includePending`.
   */
  async listLessonComments(
    tenantId: string,
    viewerId: string,
    lessonId: string,
    opts: { includePending?: boolean } = {},
  ) {
    const where = opts.includePending
      ? { tenantId, lessonId, deletedAt: null }
      : {
          tenantId,
          lessonId,
          deletedAt: null,
          OR: [{ status: 'APPROVED' as const }, { authorId: viewerId }],
        };
    return this.prisma.modLearningLessonComment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Cola de pendientes para el formador: comentarios en estado PENDING
   * de cualquier lección de un curso. La autorización (que el viewer
   * sea formador/admin del tenant) la verifica el controller.
   */
  async listPendingCommentsForCourse(tenantId: string, courseId: string) {
    return this.prisma.modLearningLessonComment.findMany({
      where: { tenantId, courseId, status: 'PENDING', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approveLessonComment(tenantId: string, reviewerId: string, commentId: string) {
    return this.prisma.modLearningLessonComment.update({
      where: { id: commentId },
      data: {
        status: 'APPROVED',
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        rejectionReason: null,
      },
    });
  }

  async rejectLessonComment(
    tenantId: string,
    reviewerId: string,
    commentId: string,
    reason?: string,
  ) {
    return this.prisma.modLearningLessonComment.update({
      where: { id: commentId },
      data: {
        status: 'REJECTED',
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        rejectionReason: reason ?? null,
      },
    });
  }

  async deleteLessonComment(tenantId: string, actorId: string, commentId: string) {
    const comment = await this.prisma.modLearningLessonComment.findFirst({
      where: { id: commentId, tenantId, deletedAt: null },
    });
    if (!comment) return; // idempotent
    if (comment.authorId !== actorId) {
      // El controller verifica si es admin/formador antes de pasar acá;
      // si no es ninguno y no es el autor, abortamos.
      throw new EnrollmentNotFoundError();
    }
    await this.prisma.modLearningLessonComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
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

  /**
   * Vista del formador/admin: detalle del progreso por lección de UN alumno en
   * UN curso. Devuelve la estructura del curso (módulos → lecciones, en orden de
   * `position`) y, para cada lección, el tiempo visto y el estado de finalización
   * del alumno. Hace left-join con el progreso real: las lecciones que el alumno
   * nunca empezó aparecen igualmente en 0 (no se ocultan).
   *
   * No hace cross-module FK — lee el usuario por su ID lógico con el mismo patrón
   * que `listEnrollmentsByCourse`.
   */
  async getEnrollmentProgressDetail(
    tenantId: string,
    courseId: string,
    enrollmentId: string,
  ): Promise<EnrollmentProgressDetail> {
    const enrollment = await this.prisma.modLearningEnrollment.findFirst({
      where: { tenantId, courseId, id: enrollmentId },
    });
    if (!enrollment) throw new EnrollmentNotFoundError();

    const user = await this.prisma.user.findFirst({
      where: { tenantId, id: enrollment.userId },
      select: { id: true, email: true, name: true },
    });

    const courseModules = await this.prisma.modCoursesModule.findMany({
      where: { tenantId, courseId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true, title: true, position: true },
    });

    const moduleIds = courseModules.map((m) => m.id);
    const lessons =
      moduleIds.length > 0
        ? await this.prisma.modCoursesLesson.findMany({
            where: { tenantId, moduleId: { in: moduleIds }, deletedAt: null },
            orderBy: { position: 'asc' },
            select: {
              id: true,
              title: true,
              type: true,
              position: true,
              durationMinutes: true,
              moduleId: true,
            },
          })
        : [];

    const progressRows = await this.prisma.modLearningProgress.findMany({
      where: { tenantId, enrollmentId },
      select: {
        lessonId: true,
        watchedSeconds: true,
        resumePositionSec: true,
        completed: true,
        completedAt: true,
        lastAccessedAt: true,
      },
    });
    const progressByLesson = new Map(progressRows.map((p) => [p.lessonId, p]));

    // Recorre las lecciones EN ORDEN del curso (módulo.position, lección.position)
    // y las agrupa por módulo con left-join contra el progreso real.
    const lessonsByModule = new Map<string, typeof lessons>();
    for (const l of lessons) {
      const arr = lessonsByModule.get(l.moduleId) ?? [];
      arr.push(l);
      lessonsByModule.set(l.moduleId, arr);
    }

    let totalWatchedSeconds = 0;
    let lessonsCompleted = 0;
    let lessonsTotal = 0;

    const modules = courseModules.map((m) => ({
      moduleId: m.id,
      moduleTitle: m.title,
      lessons: (lessonsByModule.get(m.id) ?? []).map((l) => {
        const p = progressByLesson.get(l.id);
        const watchedSeconds = p?.watchedSeconds ?? 0;
        const completed = p?.completed ?? false;
        totalWatchedSeconds += watchedSeconds;
        if (completed) lessonsCompleted += 1;
        lessonsTotal += 1;
        return {
          lessonId: l.id,
          lessonTitle: l.title,
          type: l.type as LessonType,
          durationMinutes: l.durationMinutes ?? null,
          watchedSeconds,
          resumePositionSec: p?.resumePositionSec ?? 0,
          completed,
          completedAt: p?.completedAt?.toISOString() ?? null,
          lastAccessedAt: p?.lastAccessedAt?.toISOString() ?? null,
        };
      }),
    }));

    return {
      enrollmentId: enrollment.id,
      userId: enrollment.userId,
      userEmail: user?.email ?? null,
      userName: user?.name ?? null,
      status: enrollment.status,
      progressPercent: enrollment.progressPercent,
      totalWatchedSeconds,
      lessonsCompleted,
      lessonsTotal,
      modules,
    };
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
    source: 'ADMIN' | 'CODE' | 'INVITATION_LINK' | 'PURCHASE' | 'IMPORT' | 'SUBSCRIPTION' | 'API';
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

// ── Competencias: lógica pura (testeable sin Prisma) ─────────────────────────

/** Nivel global a partir del score agregado. */
export function competencyLevel(score: number | null): string | null {
  if (score === null) return null;
  if (score < 40) return 'Inicial';
  if (score < 65) return 'Intermedio';
  if (score < 85) return 'Avanzado';
  return 'Experto';
}

/**
 * Calcula los scores de competencia de un usuario a partir del catálogo, el
 * mapeo curso↔competencia y el progreso del usuario por curso (0-100).
 * Cada competencia = media ponderada (por `weight`) del progreso en los cursos
 * mapeados en los que el usuario está matriculado. Competencias sin cursos
 * cursados se omiten. Función pura para poder testearla sin Prisma.
 */
export function computeCompetencyScores(
  competencies: Array<{ id: string; name: string }>,
  mappings: Array<{ competencyId: string; courseId: string; weight: number }>,
  progressByCourse: Map<string, number>,
): {
  competencies: Array<{ id: string; name: string; score: number }>;
  globalScore: number | null;
  globalLevel: string | null;
} {
  const byComp = new Map<string, Array<{ courseId: string; weight: number }>>();
  for (const m of mappings) {
    const arr = byComp.get(m.competencyId) ?? [];
    arr.push({ courseId: m.courseId, weight: Math.max(1, m.weight) });
    byComp.set(m.competencyId, arr);
  }

  const scored: Array<{ id: string; name: string; score: number }> = [];
  for (const c of competencies) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const m of byComp.get(c.id) ?? []) {
      const progress = progressByCourse.get(m.courseId);
      if (progress === undefined) continue; // usuario no matriculado → no aporta
      weightedSum += progress * m.weight;
      weightTotal += m.weight;
    }
    if (weightTotal === 0) continue; // sin cursos cursados → se omite
    scored.push({ id: c.id, name: c.name, score: Math.round(weightedSum / weightTotal) });
  }

  const globalScore =
    scored.length > 0 ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : null;
  return { competencies: scored, globalScore, globalLevel: competencyLevel(globalScore) };
}
