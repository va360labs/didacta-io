import { randomBytes, randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  AlreadyEnrolledError,
  CourseNotPublishedError,
  EnrollmentNotFoundError,
  InvitationInvalidError,
  LessonLockedError,
  TrialContentLockedError,
} from './errors.js';
import {
  computeDripAvailability,
  type DripRule,
  type DripUnit,
  type DripAudienceKind,
  type OrderedLesson,
} from './drip.js';
import type {
  CreateInvitationDto,
  EnrollByAdminDto,
  EnrollByCodeDto,
  EnrollByLinkDto,
  TrackProgressDto,
} from './dto.js';

/** Vista de un calendario de drip de un curso (para el panel del formador). */
export interface DripScheduleView {
  id: string;
  courseId: string;
  audienceKind: DripAudienceKind;
  audienceRef: string;
  unit: DripUnit;
  intervalDays: number;
  startOffsetDays: number;
  isActive: boolean;
}

export interface CreateDripScheduleInput {
  courseId: string;
  audienceKind: DripAudienceKind;
  audienceRef: string;
  unit?: DripUnit;
  intervalDays: number;
  startOffsetDays?: number;
  isActive?: boolean;
}

export interface UpdateDripScheduleInput {
  unit?: DripUnit;
  intervalDays?: number;
  startOffsetDays?: number;
  isActive?: boolean;
}

/** Disponibilidad de las lecciones de un curso para un alumno (drip + trial). */
export interface CourseDripAvailability {
  /** ¿El curso tiene algún gating aplicable a este alumno (drip o trial)? */
  drip: boolean;
  /**
   * Por cada lección bloqueada o programada: fecha ISO de desbloqueo (null si
   * el desbloqueo no es por fecha sino por PAGO — reason TRIAL), si ya está
   * disponible y el motivo. Sin `reason` = drip por calendario (compat).
   * Las lecciones que no aparecen están disponibles (sin gating).
   */
  lessons: Record<
    string,
    { availableAt: string | null; available: boolean; reason?: 'DRIP' | 'TRIAL' }
  >;
  /**
   * Presente cuando la membresía del alumno está EN PRUEBA y limita este curso:
   * nº de lecciones (orden global) visibles hasta que pague. La UI lo usa para
   * el candado "Disponible cuando pase el periodo de prueba" + CTA de pago.
   */
  trial?: { lessonLimit: number };
}

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
    try {
      return await this.createEnrollment({
        tenantId,
        actorId: null,
        userId,
        courseId,
        source: 'PURCHASE',
      });
    } catch (err) {
      // Ya matriculado (p.ej. por el GRUPO de la membresía): la COMPRA sella
      // la procedencia igualmente — el alumno pagó este curso y eso lo exime,
      // entre otras cosas, del límite de contenido del trial. Sin este upgrade,
      // el bridge hacía no-op y el enrollment seguía como GROUP. Se re-lanza
      // para conservar la semántica idempotente del caller (no-op esperado).
      if (err instanceof AlreadyEnrolledError) {
        await this.prisma.modLearningEnrollment.updateMany({
          where: { tenantId, userId, courseId, status: { in: ['ACTIVE', 'COMPLETED'] } },
          data: { source: 'PURCHASE' },
        });
      }
      throw err;
    }
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
    try {
      return await this.createEnrollment({
        tenantId,
        actorId: userId,
        userId,
        courseId,
        source: 'API',
      });
    } catch (err) {
      // Mismo criterio que enrollFromPurchase: una venta externa (Woo, página
      // de ventas) sobre un alumno ya matriculado por grupo sella el source.
      // Se re-lanza para conservar la semántica idempotente del caller.
      if (err instanceof AlreadyEnrolledError) {
        await this.prisma.modLearningEnrollment.updateMany({
          where: { tenantId, userId, courseId, status: { in: ['ACTIVE', 'COMPLETED'] } },
          data: { source: 'API' },
        });
      }
      throw err;
    }
  }

  /**
   * Matriculación otorgada por un grupo de acceso (mod.access-groups). Source
   * `GROUP` la diferencia para la revocación segura por refcount: solo los
   * enrollments `GROUP` se cancelan al salir del último grupo que los otorgaba
   * (`unenrollFromGroup`); compra/suscripción quedan intactos.
   *
   * Idempotente: si el alumno ya tiene enrollment ACTIVE (por otro grupo, compra
   * o suscripción), `createEnrollment` lanza `AlreadyEnrolledError`, que el
   * caller (`AccessGroupsService`) captura como no-op (el acceso ya existe; solo
   * registra el grant para el refcount).
   */
  async enrollFromGroup(tenantId: string, userId: string, courseId: string) {
    return this.createEnrollment({
      tenantId,
      actorId: null,
      userId,
      courseId,
      source: 'GROUP',
    });
  }

  /**
   * Cancela el enrollment de un grupo de acceso cuando el refcount de grants
   * vivos para (user, course) llega a 0. SOLO toca enrollments con
   * `source = 'GROUP'`: un curso obtenido además por PURCHASE/SUBSCRIPTION/API
   * (mismo (tenant,user,course), un único enrollment) NO se cancela aquí —
   * el caller decide no llamar a este método si el enrollment proviene de otra
   * fuente. No-op si no hay enrollment GROUP activo/pausado.
   */
  async unenrollFromGroup(tenantId: string, userId: string, courseId: string): Promise<void> {
    await this.prisma.modLearningEnrollment.updateMany({
      where: {
        tenantId,
        userId,
        courseId,
        status: { in: ['ACTIVE', 'PAUSED'] },
        source: 'GROUP',
      },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await this.publish(tenantId, userId, 'learning.enrollment.cancelled', { courseId, userId });
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

  /**
   * Cancela la matrícula creada por la API externa (`POST /api/v1/inscribe`)
   * cuando el sistema de ventas notifica un reembolso/cancelación del pedido.
   *
   * SOLO toca enrollments con `source = 'API'`, igual que `unenrollFromGroup` y
   * `unenrollFromSubscription`: si el alumno tiene además acceso por grupo,
   * suscripción o compra directa, ese acceso NO se revoca aquí.
   *
   * Idempotente: devuelve cuántos enrollments se cancelaron (0 = no había
   * matrícula viva por API, p. ej. reintento del webhook de reembolso).
   */
  async unenrollFromApi(tenantId: string, userId: string, courseId: string): Promise<number> {
    const { count } = await this.prisma.modLearningEnrollment.updateMany({
      where: {
        tenantId,
        userId,
        courseId,
        status: { in: ['ACTIVE', 'PAUSED'] },
        source: 'API',
      },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (count > 0) {
      await this.publish(tenantId, userId, 'learning.enrollment.cancelled', { courseId, userId });
    }
    return count;
  }

  /**
   * Cancela el acceso obtenido COMPRANDO el curso. Lo invoca el puente de
   * mod.billing al recibir un reembolso total.
   *
   * SOLO toca `source = 'PURCHASE'`, igual que sus hermanos: si el alumno tiene
   * además acceso por grupo o por la membresía, ese acceso sobrevive al
   * reembolso — le devolvimos su compra, no le quitamos lo que ya tenía.
   *
   * Idempotente: devuelve cuántas matrículas se cancelaron (0 = ya no había
   * ninguna viva por compra, p. ej. una reentrega del webhook).
   */
  async unenrollFromPurchase(tenantId: string, userId: string, courseId: string): Promise<number> {
    const { count } = await this.prisma.modLearningEnrollment.updateMany({
      where: {
        tenantId,
        userId,
        courseId,
        status: { in: ['ACTIVE', 'PAUSED'] },
        source: 'PURCHASE',
      },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (count > 0) {
      await this.publish(tenantId, userId, 'learning.enrollment.cancelled', { courseId, userId });
    }
    return count;
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

    // DRIP/TRIAL: no permitir registrar progreso en una lección aún no liberada.
    // Ancla = enrolledAt (mismo criterio que getCourseAvailability; estable).
    await this.assertLessonUnlocked(
      tenantId,
      userId,
      enrollment.courseId,
      dto.lessonId,
      enrollment.enrolledAt,
      enrollment.source,
    );

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
    // Guard de tenant ANTES de mutar: el PrismaService de módulo no aplica RLS
    // (rol con BYPASSRLS), así que update({where:{id}}) ignoraría el tenant y
    // permitiría escribir un comentario de OTRO tenant. Mismo patrón que
    // deleteLessonComment.
    const comment = await this.prisma.modLearningLessonComment.findFirst({
      where: { id: commentId, tenantId, deletedAt: null },
    });
    if (!comment) throw new EnrollmentNotFoundError();
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
    // Mismo guard de tenant que approveLessonComment (evita write cross-tenant).
    const comment = await this.prisma.modLearningLessonComment.findFirst({
      where: { id: commentId, tenantId, deletedAt: null },
    });
    if (!comment) throw new EnrollmentNotFoundError();
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
    source:
      | 'ADMIN'
      | 'CODE'
      | 'INVITATION_LINK'
      | 'PURCHASE'
      | 'IMPORT'
      | 'SUBSCRIPTION'
      | 'API'
      | 'GROUP';
  }) {
    await this.requirePublishedCourse(params.tenantId, params.courseId);

    const existing = await this.prisma.modLearningEnrollment.findFirst({
      where: {
        tenantId: params.tenantId,
        userId: params.userId,
        courseId: params.courseId,
      },
    });
    if (existing) {
      if (existing.status === 'ACTIVE') {
        throw new AlreadyEnrolledError();
      }
      if (existing.status === 'COMPLETED') {
        // Ya completó el curso: re-otorgar (p.ej. re-añadirlo a un grupo de
        // acceso) NO debe degradar la finalización ni crear otra fila (chocaría
        // con @@unique([tenantId,userId,courseId]) → P2002). No-op idempotente.
        return existing;
      }
      // CANCELLED / PAUSED: el acceso se había revocado/pausado. NO podemos
      // crear una segunda fila por el @@unique([tenantId,userId,courseId]):
      // REACTIVAMOS la existente. Esto cubre el ciclo quitar→re-añadir de los
      // grupos de acceso (unenrollFromGroup deja la fila en CANCELLED) sin
      // reventar con P2002.
      const reactivated = await this.prisma.modLearningEnrollment.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', source: params.source, cancelledAt: null },
      });
      await this.publish(params.tenantId, params.actorId, 'learning.enrollment.created', {
        enrollmentId: reactivated.id,
        userId: params.userId,
        courseId: params.courseId,
        source: params.source,
      });
      return reactivated;
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

  // ==================== DRIP (liberación programada) ====================

  /** Lista los calendarios de drip de un curso (panel del formador/admin). */
  async listDripSchedules(tenantId: string, courseId: string): Promise<DripScheduleView[]> {
    const rows = await this.prisma.modLearningDripSchedule.findMany({
      where: { tenantId, courseId },
      orderBy: [{ audienceKind: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toDripView);
  }

  async createDripSchedule(
    tenantId: string,
    input: CreateDripScheduleInput,
  ): Promise<DripScheduleView> {
    const row = await this.prisma.modLearningDripSchedule.create({
      data: {
        tenantId,
        courseId: input.courseId,
        audienceKind: input.audienceKind,
        audienceRef: input.audienceRef.trim(),
        unit: input.unit ?? 'LESSON',
        intervalDays: Math.max(1, Math.trunc(input.intervalDays)),
        startOffsetDays: Math.max(0, Math.trunc(input.startOffsetDays ?? 0)),
        isActive: input.isActive ?? true,
      },
    });
    return toDripView(row);
  }

  async updateDripSchedule(
    tenantId: string,
    id: string,
    input: UpdateDripScheduleInput,
  ): Promise<DripScheduleView> {
    const existing = await this.prisma.modLearningDripSchedule.findFirst({
      where: { tenantId, id },
      select: { id: true },
    });
    if (!existing) throw new EnrollmentNotFoundError();
    const row = await this.prisma.modLearningDripSchedule.update({
      where: { id },
      data: {
        unit: input.unit ?? undefined,
        intervalDays:
          input.intervalDays === undefined
            ? undefined
            : Math.max(1, Math.trunc(input.intervalDays)),
        startOffsetDays:
          input.startOffsetDays === undefined
            ? undefined
            : Math.max(0, Math.trunc(input.startOffsetDays)),
        isActive: input.isActive ?? undefined,
      },
    });
    return toDripView(row);
  }

  async deleteDripSchedule(tenantId: string, id: string): Promise<void> {
    await this.prisma.modLearningDripSchedule.deleteMany({ where: { tenantId, id } });
  }

  /**
   * Borra los calendarios de drip de audiencia GROUP que apuntan a un grupo de
   * acceso. Lo invoca mod.access-groups al borrar un grupo (orquestación del
   * host) para no dejar schedules huérfanos referenciando un grupo inexistente.
   */
  async deleteDripSchedulesForGroup(tenantId: string, groupId: string): Promise<number> {
    const res = await this.prisma.modLearningDripSchedule.deleteMany({
      where: { tenantId, audienceKind: 'GROUP', audienceRef: groupId },
    });
    return res.count;
  }

  /**
   * Como hasActiveEnrollment pero resolviendo el curso desde una LECCIÓN. Lo
   * usa el host para gatear la entrega del paquete SCORM (signed URL) a
   * alumnos: sin matrícula viva no hay contenido. Devuelve false si la lección
   * no existe (negar por defecto; el 404 real lo da el service de SCORM).
   */
  async hasActiveEnrollmentForLesson(
    tenantId: string,
    userId: string,
    lessonId: string,
  ): Promise<boolean> {
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
      select: { moduleId: true },
    });
    if (!lesson) return false;
    const mod = await this.prisma.modCoursesModule.findFirst({
      where: { tenantId, id: lesson.moduleId },
      select: { courseId: true },
    });
    if (!mod) return false;
    return this.hasActiveEnrollment(tenantId, userId, mod.courseId);
  }

  /**
   * ¿El usuario tiene una matrícula viva (ACTIVE/COMPLETED) en el curso? Lo usa
   * el host para gatear la entrega del CONTENIDO del curso a los alumnos (un
   * no-matriculado no debe recibir el cuerpo de las lecciones).
   */
  async hasActiveEnrollment(tenantId: string, userId: string, courseId: string): Promise<boolean> {
    const enrollment = await this.prisma.modLearningEnrollment.findUnique({
      where: { tenantId_userId_courseId: { tenantId, userId, courseId } },
      select: { status: true },
    });
    return enrollment?.status === 'ACTIVE' || enrollment?.status === 'COMPLETED';
  }

  /**
   * Disponibilidad de las lecciones de un curso para un alumno según el drip.
   * La consume el player del alumno para mostrar candados + "disponible en X días".
   */
  async getCourseAvailability(
    tenantId: string,
    userId: string,
    courseId: string,
  ): Promise<CourseDripAvailability> {
    const enrollment = await this.prisma.modLearningEnrollment.findUnique({
      where: { tenantId_userId_courseId: { tenantId, userId, courseId } },
      select: { status: true, enrolledAt: true, source: true },
    });
    // Solo aplica drip sobre una matrícula viva (no CANCELLED/PAUSED).
    if (!enrollment || (enrollment.status !== 'ACTIVE' && enrollment.status !== 'COMPLETED')) {
      return { drip: false, lessons: {} };
    }

    const now = new Date();
    const lessons: CourseDripAvailability['lessons'] = {};

    // 1) Drip RELATIVO (tier/grupo, anclado en enrolledAt) — si hay reglas.
    const rules = await this.getApplicableDripRules(tenantId, userId, courseId);
    if (rules.length > 0) {
      const ordered = await this.orderedLessons(tenantId, courseId);
      // Ancla del drip = enrolledAt (inmutable, momento real de entrada al curso).
      // NO usamos startedAt: se materializa al primer progreso y desplazaría todo
      // el calendario hacia delante, re-bloqueando lecciones ya disponibles.
      const map = computeDripAvailability(ordered, rules, enrollment.enrolledAt, now);
      for (const [lessonId, v] of map) {
        lessons[lessonId] = { availableAt: v.availableAt.toISOString(), available: v.available };
      }
    }

    // 2) Drip por FECHA ABSOLUTA (ModCoursesLesson.publishAt) — igual para todos,
    // independiente del relativo. Si coincide con el relativo, gana la fecha de
    // desbloqueo MÁS TARDÍA (una lección está disponible solo si lo está por AMBOS).
    const scheduled = await this.prisma.modCoursesLesson.findMany({
      where: { tenantId, deletedAt: null, publishAt: { not: null }, module: { courseId } },
      select: { id: true, publishAt: true },
    });
    for (const l of scheduled) {
      if (!l.publishAt) continue;
      const availableByDate = l.publishAt <= now;
      const prev = lessons[l.id];
      if (prev && prev.availableAt) {
        const prevAt = new Date(prev.availableAt);
        const laterAt = l.publishAt > prevAt ? l.publishAt : prevAt;
        lessons[l.id] = {
          availableAt: laterAt.toISOString(),
          available: prev.available && availableByDate,
        };
      } else {
        lessons[l.id] = { availableAt: l.publishAt.toISOString(), available: availableByDate };
      }
    }

    // 3) LÍMITE DEL PERIODO DE PRUEBA de la membresía: si el acceso al curso
    // viene del grupo de la membresía y la sub está TRIALING, solo las N
    // primeras lecciones (orden global) están disponibles. El desbloqueo no es
    // por fecha sino por PAGO → availableAt null + reason TRIAL. Prevalece
    // sobre el drip (una lección fuera del límite queda bloqueada aunque el
    // calendario la libere).
    const trialLimit = await this.getMembershipTrialLimit(
      tenantId,
      userId,
      courseId,
      enrollment.source,
    );
    let trial: CourseDripAvailability['trial'];
    if (trialLimit !== null) {
      trial = { lessonLimit: trialLimit };
      const ordered = await this.orderedLessons(tenantId, courseId);
      for (const l of ordered) {
        if (l.lessonIndex < trialLimit) continue;
        lessons[l.lessonId] = {
          availableAt: lessons[l.lessonId]?.availableAt ?? null,
          available: false,
          reason: 'TRIAL',
        };
      }
    }

    return { drip: Object.keys(lessons).length > 0, lessons, ...(trial ? { trial } : {}) };
  }

  /**
   * Fuentes de matrícula que EXIMEN del límite de trial: evidencian un acceso
   * PROPIO al curso, independiente de la membresía (compra directa, pago por
   * suscripción del curso, alta por API de ventas, código o invitación).
   * 'GROUP' y 'ADMIN' NO eximen: GROUP es precisamente la membresía, y ADMIN
   * es el source de la automatrícula (enrollSelf) — si eximiera, bastaría
   * cancelar la matrícula y re-automatricularse para saltarse el gate.
   */
  private static readonly TRIAL_EXEMPT_SOURCES = new Set([
    'PURCHASE',
    'SUBSCRIPTION',
    'API',
    'CODE',
    'INVITATION_LINK',
    'IMPORT',
  ]);

  /**
   * Límite de lecciones del PERIODO DE PRUEBA de la membresía para este curso,
   * o null si no aplica. Aplica solo cuando TODO se cumple:
   *   1. El tenant tiene membresía configurada (accessGroupId) con límite > 0.
   *   2. El usuario tiene una suscripción de MEMBRESÍA (planId) en TRIALING.
   *   3. Hay un grant VIVO del grupo de la membresía sobre este curso — el
   *      acceso viene de la membresía en prueba. Se decide por el GRANT (que
   *      persiste aunque el alumno cancele/re-cree su enrollment), no por el
   *      source del enrollment (manipulable vía enrollSelf).
   *   4. Ningún OTRO grupo concede el curso y el enrollment no procede de una
   *      fuente de pago propia (TRIAL_EXEMPT_SOURCES).
   *
   * Lectura cross-module first-party (ADR-016): mod_subscriptions_* y
   * mod_access_groups_* solo lectura, filtradas por tenant, declaradas en el
   * manifest (optionalModules).
   */
  private async getMembershipTrialLimit(
    tenantId: string,
    userId: string,
    courseId: string,
    enrollmentSource: string,
  ): Promise<number | null> {
    if (LearningService.TRIAL_EXEMPT_SOURCES.has(enrollmentSource)) return null;

    const config = await this.prisma.modSubscriptionsMembershipConfig.findUnique({
      where: { tenantId },
      select: { accessGroupId: true, trialLessonLimit: true },
    });
    if (!config?.accessGroupId || config.trialLessonLimit <= 0) return null;

    const trialing = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: { tenantId, userId, planId: { not: null }, status: 'TRIALING' },
      select: { id: true },
    });
    if (!trialing) return null;

    // ¿El acceso a ESTE curso viene del grupo de la membresía? (grant vivo)
    const membershipGrant = await this.prisma.modAccessGroupGrant.findFirst({
      where: { tenantId, userId, courseId, groupId: config.accessGroupId, revokedAt: null },
      select: { id: true },
    });
    if (!membershipGrant) return null;

    // ¿Algún grant vivo de OTRO grupo cubre este curso? → acceso completo.
    const otherGrant = await this.prisma.modAccessGroupGrant.findFirst({
      where: {
        tenantId,
        userId,
        courseId,
        revokedAt: null,
        NOT: { groupId: config.accessGroupId },
      },
      select: { id: true },
    });
    if (otherGrant) return null;

    return config.trialLessonLimit;
  }

  // ── Aviso de desbloqueo de lecciones programadas por fecha (publishAt) ────────

  /** El alumno pide que se le avise cuando la lección se publique. Idempotente. */
  async subscribeLessonUnlock(tenantId: string, userId: string, lessonId: string) {
    await this.prisma.modLearningLessonUnlockSub.upsert({
      where: { lessonId_userId: { lessonId, userId } },
      create: { tenantId, lessonId, userId },
      update: {},
    });
    return { subscribed: true };
  }

  /** Cancela el aviso de desbloqueo. */
  async unsubscribeLessonUnlock(tenantId: string, userId: string, lessonId: string) {
    await this.prisma.modLearningLessonUnlockSub.deleteMany({
      where: { tenantId, lessonId, userId },
    });
    return { subscribed: false };
  }

  /** ¿El alumno ya está suscrito al aviso de esta lección? */
  async isSubscribedLessonUnlock(userId: string, lessonId: string): Promise<boolean> {
    const sub = await this.prisma.modLearningLessonUnlockSub.findUnique({
      where: { lessonId_userId: { lessonId, userId } },
      select: { id: true },
    });
    return sub !== null;
  }

  /**
   * Gate de drip por `lessonId` (sin enrollmentId): resuelve el curso desde la
   * lección y la matrícula del usuario, y lanza LessonLockedError si la lección
   * no está liberada. Lo usan los endpoints SCORM (abrir/commitear attempt), que
   * no pasan por `trackProgress` y por tanto se saltaban el drip.
   */
  async assertLessonAccessible(tenantId: string, userId: string, lessonId: string): Promise<void> {
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
      select: { moduleId: true },
    });
    if (!lesson) return;
    const mod = await this.prisma.modCoursesModule.findFirst({
      where: { tenantId, id: lesson.moduleId },
      select: { courseId: true },
    });
    if (!mod) return;
    const enrollment = await this.prisma.modLearningEnrollment.findUnique({
      where: { tenantId_userId_courseId: { tenantId, userId, courseId: mod.courseId } },
      select: { status: true, enrolledAt: true, source: true },
    });
    if (!enrollment || (enrollment.status !== 'ACTIVE' && enrollment.status !== 'COMPLETED'))
      return;
    await this.assertLessonUnlocked(
      tenantId,
      userId,
      mod.courseId,
      lessonId,
      enrollment.enrolledAt,
      enrollment.source,
    );
  }

  /**
   * ¿Puede el alumno acceder a esta lección ahora? True si no hay gating
   * aplicable o si la lección ya está liberada. Lo usa `trackProgress` para
   * bloquear el registro de progreso en lecciones aún no disponibles, y los
   * endpoints SCORM vía assertLessonAccessible.
   */
  private async assertLessonUnlocked(
    tenantId: string,
    userId: string,
    courseId: string,
    lessonId: string,
    anchor: Date,
    enrollmentSource: string,
  ): Promise<void> {
    const now = new Date();
    // Fecha de publicación ABSOLUTA: si es futura, la lección está bloqueada.
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
      select: { publishAt: true },
    });
    if (lesson?.publishAt && lesson.publishAt > now) {
      throw new LessonLockedError(lesson.publishAt);
    }

    // LÍMITE DE TRIAL de la membresía: gate duro server-side. Prevalece sobre
    // el drip — fuera del límite la lección queda bloqueada hasta PAGAR, no
    // hasta una fecha.
    const trialLimit = await this.getMembershipTrialLimit(
      tenantId,
      userId,
      courseId,
      enrollmentSource,
    );
    let ordered: OrderedLesson[] | null = null;
    if (trialLimit !== null) {
      ordered = await this.orderedLessons(tenantId, courseId);
      const trialEntry = ordered.find((l) => l.lessonId === lessonId);
      if (trialEntry && trialEntry.lessonIndex >= trialLimit) {
        throw new TrialContentLockedError();
      }
    }

    // Drip RELATIVO.
    const rules = await this.getApplicableDripRules(tenantId, userId, courseId);
    if (rules.length === 0) return;
    ordered ??= await this.orderedLessons(tenantId, courseId);
    const map = computeDripAvailability(ordered, rules, anchor, now);
    const entry = map.get(lessonId);
    if (entry && !entry.available) throw new LessonLockedError(entry.availableAt);
  }

  /** Reglas de drip aplicables a un alumno (por su tier efectivo y sus grupos). */
  private async getApplicableDripRules(
    tenantId: string,
    userId: string,
    courseId: string,
  ): Promise<DripRule[]> {
    const schedules = await this.prisma.modLearningDripSchedule.findMany({
      where: { tenantId, courseId, isActive: true },
    });
    if (schedules.length === 0) return [];

    const rules: DripRule[] = [];
    const tierSchedules = schedules.filter((s) => s.audienceKind === 'TIER');
    const groupSchedules = schedules.filter((s) => s.audienceKind === 'GROUP');

    if (tierSchedules.length > 0) {
      const tierName = await this.getEffectiveTierName(tenantId, userId);
      if (tierName) {
        for (const s of tierSchedules) {
          if (s.audienceRef === tierName) rules.push(toRule(s));
        }
      }
    }
    if (groupSchedules.length > 0) {
      const groupIds = await this.getActiveGroupIds(tenantId, userId);
      for (const s of groupSchedules) {
        if (groupIds.has(s.audienceRef)) rules.push(toRule(s));
      }
    }
    return rules;
  }

  /**
   * Tier EFECTIVO del usuario (manual ?? derivado) leyendo la tabla de
   * mod.payment-connections. Cross-table read first-party (ADR-016): filtrado por
   * tenant_id, sin escritura, dependencia declarada en el manifest de mod.learning.
   */
  private async getEffectiveTierName(tenantId: string, userId: string): Promise<string | null> {
    const ut = await this.prisma.modPaymentConnectionsUserTier.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: { manualTier: { select: { name: true } } },
    });
    if (!ut) return null;
    return ut.manualTier?.name ?? ut.derivedLabel ?? null;
  }

  /** IDs de los grupos de acceso ACTIVE del usuario (cross-table read, ADR-016). */
  private async getActiveGroupIds(tenantId: string, userId: string): Promise<Set<string>> {
    const rows = await this.prisma.modAccessGroupMember.findMany({
      where: { tenantId, userId, status: 'ACTIVE' },
      select: { groupId: true },
    });
    return new Set(rows.map((r) => r.groupId));
  }

  /** Lecciones del curso en orden global (módulo.position → lección.position). */
  private async orderedLessons(tenantId: string, courseId: string): Promise<OrderedLesson[]> {
    const modules = await this.prisma.modCoursesModule.findMany({
      where: { tenantId, courseId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    const out: OrderedLesson[] = [];
    let lessonIndex = 0;
    let moduleIndex = 0;
    for (const mod of modules) {
      const lessons = await this.prisma.modCoursesLesson.findMany({
        where: { tenantId, moduleId: mod.id, deletedAt: null },
        orderBy: { position: 'asc' },
        select: { id: true },
      });
      for (const l of lessons) {
        out.push({ lessonId: l.id, lessonIndex: lessonIndex++, moduleIndex });
      }
      moduleIndex += 1;
    }
    return out;
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

/** Fila Prisma de drip → vista pública. */
function toDripView(row: {
  id: string;
  courseId: string;
  audienceKind: string;
  audienceRef: string;
  unit: string;
  intervalDays: number;
  startOffsetDays: number;
  isActive: boolean;
}): DripScheduleView {
  return {
    id: row.id,
    courseId: row.courseId,
    audienceKind: row.audienceKind as DripAudienceKind,
    audienceRef: row.audienceRef,
    unit: row.unit as DripUnit,
    intervalDays: row.intervalDays,
    startOffsetDays: row.startOffsetDays,
    isActive: row.isActive,
  };
}

function toRule(row: { unit: string; intervalDays: number; startOffsetDays: number }): DripRule {
  return {
    unit: row.unit as DripUnit,
    intervalDays: row.intervalDays,
    startOffsetDays: row.startOffsetDays,
  };
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
