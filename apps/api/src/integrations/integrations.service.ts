/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { MEMBERSHIP_LIVE_STATUSES } from '@didacta/mod-subscriptions';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  IntegrationCourseDetail,
  IntegrationCourseListResponse,
  IntegrationEnrollmentTotals,
  IntegrationLearnerCourseState,
  IntegrationLearnerEnrollment,
  IntegrationLearnerMembership,
  IntegrationLearnerState,
  IntegrationNextLesson,
  IntegrationExternalOrder,
  IntegrationLearnerOrders,
  IntegrationTenantTotals,
  LearnerOrdersQuery,
  ListCoursesQuery,
  UpsertExternalOrderDto,
} from './integrations.dto';

/** Estados de matrícula que dan acceso real a las clases hoy. */
const ACCESS_STATUSES = new Set(['ACTIVE', 'COMPLETED']);

/**
 * Un curso sin ninguna matrícula no aparece en el `groupBy`, y ausencia no es
 * lo mismo que cero para quien pinta la ficha: `undefined` se cuela como "—".
 */
const SIN_MATRICULAS: IntegrationEnrollmentTotals = { enrollments: 0, enrollmentsActive: 0 };

/**
 * Las columnas de id son `uuid` en Postgres: pasarle "curso-de-n8n" a un
 * `where: { id }` no da 404, revienta con un error de conversión que sale por
 * la puerta como 500. Y un 500 el integrador no lo puede tratar como "no
 * existe". Se distingue antes de consultar.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lectura del catálogo y del estado del alumno para integradores externos.
 *
 * Es CORE del host, igual que `InscribeService`: no vive en un módulo del
 * marketplace porque su razón de ser es servir a un sistema de fuera. Lee las
 * tablas de mod.courses y mod.learning directamente (patrón ya establecido en
 * `BillingPublicController`) con un `select` explícito, por dos motivos:
 *
 *  1. El `content` de las lecciones NO debe salir nunca por aquí. No basta con
 *     no serializarlo: pedirlo a Postgres y tirarlo son bytes y memoria por
 *     cada lección de cada visita.
 *  2. La ficha se pinta en una página de venta con tráfico real. Traer solo lo
 *     que se pinta mantiene la consulta plana y predecible.
 *
 * Depende únicamente de módulos de categoría `core` (courses, learning,
 * billing, certificates), que `TenantModulesService` no deja desactivar. No
 * asume ningún módulo opcional: en particular, NO requiere `mod.wp-sso`.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly logger: PinoLogger,
  ) {}

  /** Catálogo para mapear "producto del sitio externo" → "curso de Didacta". */
  async listCourses(
    tenantId: string,
    query: ListCoursesQuery,
  ): Promise<IntegrationCourseListResponse> {
    const courses = await this.prisma.modCoursesCourse.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(query.slug ? { slug: query.slug } : {}),
        ...(query.externalId ? { externalId: query.externalId } : {}),
        ...(query.externalSource ? { externalSource: query.externalSource } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ status: 'asc' }, { title: 'asc' }],
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        category: true,
        thumbnailUrl: true,
        publishedAt: true,
        externalSource: true,
        externalId: true,
      },
    });
    const [porCurso, tenantTotals] = await Promise.all([
      this.countEnrollmentsByCourse(
        tenantId,
        courses.map((c) => c.id),
      ),
      this.countTenantLearners(tenantId),
    ]);

    return {
      courses: courses.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        status: c.status,
        category: c.category,
        thumbnailUrl: c.thumbnailUrl,
        publishedAt: c.publishedAt?.toISOString() ?? null,
        externalSource: c.externalSource,
        externalId: c.externalId,
        totals: porCurso.get(c.id) ?? SIN_MATRICULAS,
      })),
      tenantTotals,
    };
  }

  /**
   * Ficha completa: metadatos + temario + oferta. Devuelve el curso en
   * cualquier estado (el integrador ve `status` y decide), porque quien llama
   * es el propio tenant con su API key, igual que en `/inscribe/courses`.
   *
   * `courseId` admite el UUID o el slug. El slug no es una comodidad: la ruta
   * es lo primero que prueba quien tiene la URL del curso delante, y con
   * `@@unique([tenantId, slug])` resuelve a uno solo. Lo que NO puede pasar es
   * que un identificador con letras acabe en un 500.
   */
  async getCourseDetail(tenantId: string, courseId: string): Promise<IntegrationCourseDetail> {
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        ...(UUID_RE.test(courseId) ? { id: courseId } : { slug: courseId }),
      },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        status: true,
        category: true,
        thumbnailUrl: true,
        featuredVideoUrl: true,
        language: true,
        estimatedMinutes: true,
        publishedAt: true,
        externalSource: true,
        externalId: true,
        externalPurchaseUrl: true,
        certificateTemplateId: true,
        createdById: true,
        modules: {
          where: { deletedAt: null },
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            description: true,
            position: true,
            lessons: {
              where: { deletedAt: null },
              orderBy: { position: 'asc' },
              // Nótese la ausencia deliberada de `content`.
              select: {
                id: true,
                title: true,
                type: true,
                position: true,
                durationMinutes: true,
                publishAt: true,
              },
            },
          },
        },
      },
    });
    if (!course) {
      throw new NotFoundException({
        message: 'Curso no encontrado.',
        code: 'INTEGRATIONS_COURSE_NOT_FOUND',
      });
    }

    const now = new Date();
    let lessonCount = 0;
    let minutes = 0;
    const modules = course.modules.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      position: m.position,
      lessons: m.lessons.map((l) => {
        lessonCount += 1;
        minutes += l.durationMinutes ?? 0;
        return {
          id: l.id,
          title: l.title,
          type: l.type,
          position: l.position,
          durationMinutes: l.durationMinutes,
          scheduled: l.publishAt !== null && l.publishAt > now,
        };
      }),
    }));

    const [instructor, hasCertificate, offer, matriculas] = await Promise.all([
      this.resolveInstructor(tenantId, course.createdById),
      this.resolveHasCertificate(tenantId, course.certificateTemplateId),
      this.resolveOffer(tenantId, course.id),
      this.countEnrollmentsByCourse(tenantId, [course.id]),
    ]);

    return {
      id: course.id,
      slug: course.slug,
      title: course.title,
      description: course.description,
      status: course.status,
      category: course.category,
      thumbnailUrl: course.thumbnailUrl,
      featuredVideoUrl: course.featuredVideoUrl,
      language: course.language,
      estimatedMinutes: course.estimatedMinutes,
      publishedAt: course.publishedAt?.toISOString() ?? null,
      externalSource: course.externalSource,
      externalId: course.externalId,
      externalPurchaseUrl: course.externalPurchaseUrl,
      hasCertificate,
      instructor,
      totals: {
        modules: modules.length,
        lessons: lessonCount,
        minutes,
        ...(matriculas.get(course.id) ?? SIN_MATRICULAS),
      },
      modules,
      offer,
    };
  }

  /**
   * Estado del alumno identificado por email dentro del tenant de la API key.
   *
   * La identidad es el email a propósito: es el único dato que un sitio
   * externo tiene siempre, sin depender de que haya un módulo de SSO
   * instalado. Quien llama ya es el tenant (tiene su API key), así que esto no
   * amplía lo que puede saber — pero sí permite preguntar por CUALQUIER email,
   * y por eso vive tras su propio scope `enrollments:read`.
   */
  async getLearnerState(
    tenantId: string,
    email: string,
    courseId: string | undefined,
    webBaseUrl: string,
  ): Promise<IntegrationLearnerState> {
    const user = await this.findUserByEmail(tenantId, email);
    if (!user) {
      return {
        known: false,
        userId: null,
        name: null,
        enrollments: [],
        course: null,
        membership: null,
      };
    }

    const rows = await this.prisma.modLearningEnrollment.findMany({
      where: { tenantId, userId: user.id },
      orderBy: { enrolledAt: 'desc' },
      select: {
        id: true,
        courseId: true,
        status: true,
        source: true,
        progressPercent: true,
        enrolledAt: true,
        completedAt: true,
      },
    });

    // Un solo viaje a mod.courses para poner título y slug a cada matrícula:
    // el integrador los necesita para enlazar "mis cursos" sin pedir la ficha
    // de cada uno.
    const courseIds = [...new Set(rows.map((r) => r.courseId))];
    const courses =
      courseIds.length > 0
        ? await this.prisma.modCoursesCourse.findMany({
            where: { tenantId, id: { in: courseIds } },
            select: { id: true, title: true, slug: true },
          })
        : [];
    const courseById = new Map(courses.map((c) => [c.id, c]));

    const enrollments: IntegrationLearnerEnrollment[] = rows.map((r) => ({
      courseId: r.courseId,
      courseTitle: courseById.get(r.courseId)?.title ?? null,
      courseSlug: courseById.get(r.courseId)?.slug ?? null,
      status: r.status,
      source: r.source,
      progressPercent: r.progressPercent,
      enrolledAt: r.enrolledAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    }));

    const course = courseId
      ? await this.buildCourseState(
          tenantId,
          user.id,
          courseId,
          rows.find((r) => r.courseId === courseId) ?? null,
          webBaseUrl,
        )
      : null;

    return {
      known: true,
      userId: user.id,
      name: user.name,
      enrollments,
      course,
      membership: await this.buildMembershipState(tenantId, user.id),
    };
  }

  /**
   * La membresía viva del alumno, para que quien vende fuera pueda no vendérsela
   * dos veces. `planId: { not: null }` es lo que separa la membresía de una
   * suscripción por curso: las dos comparten tabla.
   *
   * Los estados que cuentan salen de `MEMBERSHIP_LIVE_STATUSES`, importado del
   * módulo en vez de reescrito aquí: si esta lista y la del guard del checkout
   * se separaran, la tienda externa vería «no tiene» justo en el caso en que el
   * aula le diría «ya tienes» — y el duplicado que esto evita volvería por la
   * puerta de al lado.
   */
  private async buildMembershipState(
    tenantId: string,
    userId: string,
  ): Promise<IntegrationLearnerMembership | null> {
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId,
        userId,
        planId: { not: null },
        status: { in: [...MEMBERSHIP_LIVE_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        planId: true,
        interval: true,
        unitAmount: true,
        currency: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
      },
    });
    if (!sub) return null;

    const plan = sub.planId
      ? await this.prisma.modSubscriptionsPlan.findFirst({
          where: { id: sub.planId, tenantId },
          select: { name: true },
        })
      : null;

    return {
      status: sub.status,
      planId: sub.planId,
      planName: plan?.name ?? null,
      interval: sub.interval,
      amountCents: sub.unitAmount,
      currency: sub.currency,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    };
  }

  // ------------------------------------------------------------------ privados

  /**
   * Matrículas por curso, en una sola consulta para toda la lista: contar
   * curso a curso convertiría un catálogo de quince en quince viajes.
   * Agrupa por `(courseId, status)` —el índice `[tenantId, courseId, status]`
   * lo cubre entero— y reparte cada montón en histórico y activo.
   *
   * Cuenta filas de matrícula, no personas: la clave `[tenantId, userId,
   * courseId]` es única, así que dentro de UN curso una fila es una persona.
   * Entre cursos ya no, y por eso el total del tenant se calcula aparte.
   */
  private async countEnrollmentsByCourse(
    tenantId: string,
    courseIds: string[],
  ): Promise<Map<string, IntegrationEnrollmentTotals>> {
    const porCurso = new Map<string, IntegrationEnrollmentTotals>();
    if (courseIds.length === 0) return porCurso;

    const grupos = await this.prisma.modLearningEnrollment.groupBy({
      by: ['courseId', 'status'],
      where: { tenantId, courseId: { in: courseIds } },
      _count: { _all: true },
    });

    for (const grupo of grupos) {
      const acc = porCurso.get(grupo.courseId) ?? { enrollments: 0, enrollmentsActive: 0 };
      const n = grupo._count._all;
      acc.enrollments += n;
      if (ACCESS_STATUSES.has(grupo.status)) acc.enrollmentsActive += n;
      porCurso.set(grupo.courseId, acc);
    }
    return porCurso;
  }

  /**
   * Alumnos distintos del tenant. Es el número de la portada de una web de
   * venta, y NO es la suma de los cursos: quien compró tres cuenta una vez.
   *
   * Se agrupa por `userId` y se cuentan los grupos —la deduplicación la hace
   * Postgres— en vez de traerse las matrículas para contarlas en memoria.
   */
  private async countTenantLearners(tenantId: string): Promise<IntegrationTenantTotals> {
    const porAlumno = await this.prisma.modLearningEnrollment.groupBy({
      by: ['userId'],
      where: { tenantId },
      _count: { _all: true },
    });
    return {
      learners: porAlumno.length,
      enrollments: porAlumno.reduce((total, fila) => total + fila._count._all, 0),
    };
  }

  /**
   * Busca por (tenant, email) exacto —la misma clave única que usa
   * `/inscribe`— y solo si falla reintenta sin distinguir mayúsculas. El orden
   * importa: si un tenant arrastra dos filas que difieren únicamente en la
   * caja, la exacta es la que `/inscribe` matricularía, y las dos respuestas
   * tienen que hablar del mismo usuario.
   */
  private async findUserByEmail(tenantId: string, email: string) {
    const exact = await this.prisma.user.findFirst({
      where: { tenantId, email },
      select: { id: true, name: true },
    });
    if (exact) return exact;
    return this.prisma.user.findFirst({
      where: { tenantId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  /** Detalle de progreso en un curso, con la lección por la que continuar. */
  private async buildCourseState(
    tenantId: string,
    userId: string,
    courseId: string,
    enrollment: {
      id: string;
      status: string;
      progressPercent: number;
    } | null,
    webBaseUrl: string,
  ): Promise<IntegrationLearnerCourseState> {
    const modules = await this.prisma.modCoursesModule.findMany({
      where: { tenantId, courseId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        title: true,
        lessons: {
          where: { deletedAt: null },
          orderBy: { position: 'asc' },
          select: { id: true, title: true },
        },
      },
    });
    const ordered = modules.flatMap((m) =>
      m.lessons.map((l) => ({ ...l, moduleId: m.id, moduleTitle: m.title })),
    );

    const completedIds = enrollment
      ? (
          await this.prisma.modLearningProgress.findMany({
            where: { tenantId, enrollmentId: enrollment.id, completed: true },
            select: { lessonId: true },
          })
        ).map((p) => p.lessonId)
      : [];
    const completed = new Set(completedIds);

    // Enlazar a una lección que el drip todavía no ha liberado sería mandar al
    // alumno a un muro. Se descartan antes de elegir: `available === false` es
    // bloqueada; sin entrada en el mapa, disponible (mismo criterio que la web).
    const availability = await this.resolveAvailability(tenantId, userId, courseId, enrollment);
    const abiertas = ordered.filter((l) => availability[l.id]?.available !== false);

    // "Continuar": la primera sin completar de las abiertas, o la primera
    // abierta si ya están todas hechas (repaso). Misma regla que el botón de la
    // web de Didacta — al vivir aquí deja de estar duplicada en cada cliente.
    // Si el drip no ha liberado nada todavía, `null`: el integrador enseña
    // "empieza el día X" en vez de un enlace muerto.
    const next = abiertas.find((l) => !completed.has(l.id)) ?? abiertas[0] ?? null;
    const nextLesson: IntegrationNextLesson | null = next
      ? {
          id: next.id,
          title: next.title,
          moduleId: next.moduleId,
          moduleTitle: next.moduleTitle,
          url: `${webBaseUrl.replace(/\/$/, '')}/clase/${next.id}`,
        }
      : null;

    const cancelled = enrollment?.status === 'CANCELLED';
    return {
      courseId,
      enrolled: enrollment !== null && !cancelled,
      hasAccess: enrollment !== null && ACCESS_STATUSES.has(enrollment.status),
      status: enrollment?.status ?? null,
      progressPercent: enrollment?.progressPercent ?? 0,
      lessonsCompleted: completed.size,
      lessonsTotal: ordered.length,
      completedLessonIds: completedIds,
      nextLesson,
    };
  }

  /**
   * Qué lecciones tiene liberadas ESTE alumno (drip relativo por tier/grupo y
   * drip por fecha absoluta). Solo se pregunta si hay matrícula con acceso:
   * `getCourseAvailability` ya devuelve el mapa vacío en cualquier otro caso, y
   * ahorrárselo evita una consulta por visita de quien todavía no ha comprado.
   *
   * Si el módulo falla, se degrada a "todo abierto": el peor resultado es un
   * enlace a una clase bloqueada, y eso es preferible a tumbar la ficha.
   */
  private async resolveAvailability(
    tenantId: string,
    userId: string,
    courseId: string,
    enrollment: { status: string } | null,
  ): Promise<Record<string, { available: boolean }>> {
    if (!enrollment || !ACCESS_STATUSES.has(enrollment.status)) return {};
    try {
      const result = await this.registry
        .getLearningService()
        .getCourseAvailability(tenantId, userId, courseId);
      return result.drip ? result.lessons : {};
    } catch (error) {
      this.logger.warn(
        { err: error, tenantId, courseId },
        'integrations: no se pudo resolver el drip; se asume todo liberado',
      );
      return {};
    }
  }

  private async resolveInstructor(tenantId: string, createdById: string | null) {
    if (!createdById) return null;
    const user = await this.prisma.user.findFirst({
      where: { tenantId, id: createdById },
      select: { name: true, jobTitle: true, avatarUrl: true },
    });
    if (!user) return null;
    return { name: user.name, jobTitle: user.jobTitle, avatarUrl: user.avatarUrl };
  }

  /**
   * Hay certificado si el curso apunta a una plantilla o si el tenant tiene
   * una por defecto (que es la que se aplica cuando el curso no elige).
   */
  private async resolveHasCertificate(
    tenantId: string,
    certificateTemplateId: string | null,
  ): Promise<boolean> {
    if (certificateTemplateId) return true;
    const fallback = await this.prisma.modCertificatesTemplate.findFirst({
      where: { tenantId, isDefault: true },
      select: { id: true },
    });
    return fallback !== null;
  }

  /**
   * La oferta es un extra: la mayoría de los integradores cobran en su propia
   * tienda y no configuran precios en Didacta. Si mod.billing no puede
   * responder, la ficha se sirve igual sin precios — una página de venta no se
   * puede quedar en blanco porque el módulo de cobro tenga un mal día.
   */
  private async resolveOffer(tenantId: string, courseId: string) {
    try {
      return await this.registry.getBillingService().getCourseOffer(tenantId, courseId);
    } catch (error) {
      this.logger.warn(
        { err: error, tenantId, courseId },
        'integrations: no se pudo leer la oferta del curso; se sirve la ficha sin precios',
      );
      return { forSale: false, options: [] };
    }
  }

  // ==========================================================================
  // Compras hechas fuera
  // ==========================================================================

  /**
   * Guarda —o actualiza— una compra hecha en una tienda externa.
   *
   * **Idempotente por `(tenant, source, reference)`.** Es el requisito de fondo,
   * no un detalle: quien llama a esto es un webhook de cobro, y un webhook se
   * reintenta. Sin esta clave, el reintento de una pasarela le duplicaría el
   * historial a un alumno que no ha comprado dos veces.
   *
   * **Lo que se omite no se borra.** `invoice`, `orderUrl` y `refundedAt` solo
   * se escriben si vienen en el cuerpo. Es lo que permite el camino normal de
   * una tienda —cobrar y mandar el pedido; emitir la factura media hora después
   * y volver con el número— sin que la segunda llamada tenga que reenviar todo
   * ni la primera pise lo que ya había.
   *
   * ⚠️ `userId` se resuelve por email **en el momento de escribir**, y puede
   * quedarse en `null` para siempre si la tienda manda el pedido antes de
   * llamar a `/inscribe`. No es un fallo: la lectura busca por `userId` O por
   * email. Lo que sí se pierde en ese caso es el pedido de quien luego cambie
   * de correo en el aula — para eso basta con que la tienda lo reenvíe.
   */
  async upsertExternalOrder(
    tenantId: string,
    dto: UpsertExternalOrderDto,
  ): Promise<IntegrationExternalOrder> {
    const email = dto.email.toLowerCase();
    const user = await this.findUserByEmail(tenantId, dto.email);

    // Campos que siempre viajan y siempre se escriben.
    const base = {
      email,
      status: dto.status,
      amountCents: dto.amountCents,
      currency: dto.currency,
      lines: dto.lines,
      placedAt: new Date(dto.placedAt),
    };

    // Los opcionales, solo si vienen. Ver el aviso de arriba.
    const opcionales = {
      ...(dto.invoice === null
        ? // Retirada explícita: la factura dejó de existir en la contabilidad de
          // quien vende, y el perfil no puede seguir anunciándola.
          { invoiceNumber: null, invoiceIssuedAt: null, invoiceUrl: null }
        : dto.invoice
          ? {
              invoiceNumber: dto.invoice.number ?? null,
              invoiceIssuedAt: dto.invoice.issuedAt ? new Date(dto.invoice.issuedAt) : null,
              invoiceUrl: dto.invoice.url ?? null,
            }
          : {}),
      ...(dto.orderUrl !== undefined ? { orderUrl: dto.orderUrl } : {}),
      ...(dto.refundedAt !== undefined ? { refundedAt: new Date(dto.refundedAt) } : {}),
    };

    const row = await this.prisma.externalOrder.upsert({
      where: {
        tenantId_source_reference: { tenantId, source: dto.source, reference: dto.reference },
      },
      create: {
        tenantId,
        source: dto.source,
        reference: dto.reference,
        userId: user?.id ?? null,
        ...base,
        ...opcionales,
      },
      update: {
        ...base,
        ...opcionales,
        // Solo se ata la cuenta, nunca se desata: si el pedido ya estaba
        // enlazado y hoy el email no resuelve —porque el alumno lo cambió en el
        // aula—, mantenerlo es lo correcto.
        ...(user ? { userId: user.id } : {}),
      },
    });

    this.logger.log(
      { tenantId, source: dto.source, reference: dto.reference, linked: row.userId !== null },
      'integrations: compra externa guardada',
    );

    return this.toExternalOrder(row);
  }

  /**
   * El historial de compra de un alumno, por email.
   *
   * Busca por `userId` **y** por email a propósito. Solo por la cuenta se
   * perderían los pedidos que llegaron antes de que existiera; solo por el
   * correo se perderían los de quien lo cambió después. Es el mismo problema
   * que resuelve la zona de cliente de cualquier tienda que haya sobrevivido a
   * una migración.
   */
  async listLearnerOrders(
    tenantId: string,
    query: LearnerOrdersQuery,
  ): Promise<IntegrationLearnerOrders> {
    const email = query.email.toLowerCase();
    const user = await this.findUserByEmail(tenantId, query.email);

    const rows = await this.prisma.externalOrder.findMany({
      where: {
        tenantId,
        ...(query.source ? { source: query.source } : {}),
        OR: user ? [{ userId: user.id }, { email }] : [{ email }],
      },
      orderBy: { placedAt: 'desc' },
      take: query.limit,
    });

    return {
      known: user !== null,
      userId: user?.id ?? null,
      orders: rows.map((r) => this.toExternalOrder(r)),
    };
  }

  /**
   * Lo mismo, pero para el alumno que mira su propio perfil en el aula.
   *
   * No acepta email por parámetro **a propósito**: el sujeto es el token. Un
   * endpoint de perfil que reciba de quién quieres ver las compras es un
   * endpoint que antes o después sirve las de otro.
   *
   * Busca por cuenta Y por el correo de esa cuenta, por el mismo motivo que la
   * versión de la tienda: los pedidos que llegaron antes de que el alumno
   * existiera en el aula tienen `user_id` a null y solo se localizan por email.
   */
  async listOwnOrders(tenantId: string, userId: string): Promise<IntegrationLearnerOrders> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, email: true },
    });
    if (!user) return { known: false, userId: null, orders: [] };

    const rows = await this.prisma.externalOrder.findMany({
      where: {
        tenantId,
        OR: [{ userId: user.id }, { email: user.email.toLowerCase() }],
      },
      orderBy: { placedAt: 'desc' },
      take: 200,
    });

    return {
      known: true,
      userId: user.id,
      orders: rows.map((r) => this.toExternalOrder(r)),
    };
  }

  /**
   * Fila → contrato público.
   *
   * `lines` es una columna `Json` y Prisma la tipa como `JsonValue`: lo que
   * salga de ahí es lo que entró, y entró validado por zod en el controlador.
   * Se comprueba que sea un array antes de servirlo porque una fila escrita a
   * mano en la base de datos no ha pasado por esa validación, y un objeto suelto
   * ahí rompería el `map` de quien pinta la lista.
   */
  private toExternalOrder(row: {
    id: string;
    source: string;
    reference: string;
    status: string;
    amountCents: number;
    currency: string;
    lines: unknown;
    invoiceNumber: string | null;
    invoiceIssuedAt: Date | null;
    invoiceUrl: string | null;
    orderUrl: string | null;
    placedAt: Date;
    refundedAt: Date | null;
    userId: string | null;
  }): IntegrationExternalOrder {
    return {
      id: row.id,
      source: row.source,
      reference: row.reference,
      status: row.status,
      amountCents: row.amountCents,
      currency: row.currency,
      lines: Array.isArray(row.lines) ? (row.lines as IntegrationExternalOrder['lines']) : [],
      // Hay factura si hay número **o** enlace: emitida y sin numerar sigue
      // siendo una factura que el alumno puede descargar.
      invoice:
        (row.invoiceNumber ?? row.invoiceUrl)
          ? {
              number: row.invoiceNumber,
              issuedAt: row.invoiceIssuedAt?.toISOString() ?? null,
              url: row.invoiceUrl,
            }
          : null,
      orderUrl: row.orderUrl,
      placedAt: row.placedAt.toISOString(),
      refundedAt: row.refundedAt?.toISOString() ?? null,
      linkedToUser: row.userId !== null,
    };
  }
}
