import { Injectable, NotFoundException } from '@nestjs/common';
import type { ClientContext } from '../auth/client-context';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { RestrictionService, type RestrictionRecord } from './restriction.service';

/**
 * Expediente de un usuario: todo lo que la plataforma sabe de una persona,
 * reunido en una sola respuesta.
 *
 * ── Sobre la arquitectura ────────────────────────────────────────────────────
 * El modelo `User` solo tiene cuatro relaciones Prisma reales (`sessions`,
 * `apiKeys`, `roles`, `externalIdentities`); todo lo demás son `userId`
 * lógicos sin FK, por el contrato modular. Así que esto no es un `include`
 * sino ~15 consultas en paralelo, cada una filtrada por `tenantId`.
 *
 * Lee tablas de módulos sin escribir en ninguna, y es código del core, no de
 * un módulo: ningún módulo se entera de que el expediente existe. Aun así es
 * la primera vez que el core cruza tantas tablas de módulos a la vez, y eso
 * merece un ADR (ver resumen de la entrega).
 *
 * ── Sobre privacidad ─────────────────────────────────────────────────────────
 * Incluye el contenido íntegro de los mensajes privados, por decisión expresa
 * del responsable del producto. Por eso cada apertura del expediente queda
 * registrada en `audit_log` con quién miró a quién: es lo que hace auditable
 * el acceso. Requiere además reflejarlo en la política de privacidad.
 */

/** Cuántas filas se traen de cada colección larga. */
const RECENT = 25;
const RECENT_MESSAGES = 50;

export interface UserDossier {
  identity: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    bio: string | null;
    jobTitle: string | null;
    department: string | null;
    location: string | null;
    status: string;
    roles: string[];
    emailVerified: boolean;
    mfaEnabled: boolean;
    locale: string;
    timezone: string;
    documentId: string | null;
    externalSource: string | null;
    externalId: string | null;
    createdAt: string;
    lastLoginAt: string | null;
    onboardingCompletedAt: string | null;
    /** Días desde el alta. Es «cuánto tiempo lleva» sin hacer la cuenta. */
    membershipDays: number;
  };
  commerce: {
    orders: Array<{
      id: string;
      courseId: string;
      courseTitle: string | null;
      status: string;
      amountPaid: number | null;
      currency: string;
      completedAt: string | null;
      refundedAt: string | null;
      createdAt: string;
    }>;
    /** Suma de lo efectivamente cobrado y no devuelto, en céntimos. */
    totalPaidCents: number;
    subscriptions: Array<{
      id: string;
      courseId: string | null;
      planName: string | null;
      status: string;
      unitAmount: number;
      currency: string;
      interval: string;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      trialEndsAt: string | null;
      canceledAt: string | null;
      /** Días que faltan para el vencimiento. Negativo si ya venció. */
      daysToRenewal: number | null;
    }>;
    /** Suscripciones detectadas en pasarelas externas (mod.payment-connections). */
    externalSubscriptions: Array<{
      provider: string;
      productName: string | null;
      status: string;
      entitled: boolean;
      currentPeriodEnd: string | null;
    }>;
    /**
     * Compras hechas en la tienda externa (WooCommerce), reflejadas por el
     * espejo de `mod.payment-connections`.
     *
     * Es donde vive el histórico de verdad cuando el tenant vende fuera:
     * lo comprado en la tienda externa no pasa por el Stripe de Didacta.
     */
    externalOrders: Array<{
      id: string;
      provider: string;
      externalId: string;
      status: string;
      paid: boolean;
      totalAmount: number;
      currency: string;
      placedAt: string;
      paidAt: string | null;
      refundedAt: string | null;
      /** LIFETIME | SUBSCRIPTION | TIMED | ONE_OFF | INFRA */
      entitlementKind: string;
      /** Solo para TIMED: cuándo se acaba el acceso que dio esta compra. */
      accessEndsAt: string | null;
      /** Días que faltan para que caduque. Negativo si ya caducó. */
      daysToExpiry: number | null;
      products: string[];
    }>;
    /** Suma de TODO lo cobrado y no devuelto, dentro y fuera de Didacta. */
    totalPaidExternalCents: number;
    /** Fecha de la primera compra: la antigüedad real como cliente. */
    customerSince: string | null;
  };
  learning: {
    enrollments: Array<{
      courseId: string;
      courseTitle: string | null;
      status: string;
      progressPercent: number;
      enrolledAt: string;
      completedAt: string | null;
    }>;
    certificates: Array<{
      id: string;
      courseId: string;
      number: string;
      issuedAt: string;
      revokedAt: string | null;
    }>;
    quizAttempts: Array<{
      id: string;
      quizId: string;
      scorePercent: number | null;
      passed: boolean | null;
      submittedAt: string | null;
    }>;
    liveAttendance: Array<{
      sessionId: string;
      present: boolean;
      minutes: number | null;
      joinedAt: string | null;
    }>;
  };
  activity: {
    counts: {
      posts: number;
      comments: number;
      reactions: number;
      messages: number;
      lessonComments: number;
      resources: number;
      aiQuestions: number;
    };
    posts: Array<{
      id: string;
      title: string | null;
      body: string;
      createdAt: string;
      hiddenAt: string | null;
      deletedAt: string | null;
    }>;
    comments: Array<{
      id: string;
      postId: string;
      body: string;
      createdAt: string;
      hiddenAt: string | null;
      deletedAt: string | null;
    }>;
  };
  messages: {
    total: number;
    /** Contenido íntegro. Ver nota de privacidad en la cabecera del fichero. */
    recent: Array<{
      id: string;
      conversationId: string;
      conversationType: string;
      body: string;
      kind: string;
      createdAt: string;
      deletedAt: string | null;
    }>;
  };
  gamification: {
    lifetimePoints: number;
    levelKey: string | null;
    levelReachedAt: string | null;
  } | null;
  access: {
    recentSessions: Array<{
      id: string;
      createdAt: string;
      expiresAt: string;
      ip: string | null;
      userAgent: string | null;
    }>;
    externalIdentities: Array<{
      provider: string;
      issuer: string;
      linkedAt: string;
      lastSeenAt: string | null;
    }>;
  };
  restrictions: RestrictionRecord[];
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Nombres de producto de un pedido del espejo.
 *
 * `items` es JSON del proveedor: se valida en vez de castear, porque una fila
 * antigua o un pedido raro no deben tumbar el expediente entero.
 */
function productNamesOf(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((i) =>
      i && typeof i === 'object' && typeof (i as { name?: unknown }).name === 'string'
        ? (i as { name: string }).name
        : null,
    )
    .filter((n): n is string => !!n);
}

@Injectable()
export class DossierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly restrictions: RestrictionService,
  ) {}

  async get(
    tenantId: string,
    actorId: string,
    userId: string,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<UserDossier> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
      include: {
        roles: { select: { role: { select: { name: true } } } },
        sessions: { orderBy: { createdAt: 'desc' }, take: 10 },
        externalIdentities: true,
      },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const now = new Date();

    // Todo en paralelo: son consultas independientes contra tablas distintas.
    const [
      orders,
      subscriptions,
      externalSubs,
      externalOrders,
      enrollments,
      certificates,
      quizAttempts,
      attendance,
      posts,
      comments,
      reactionCount,
      lessonCommentCount,
      resourceCount,
      aiUsage,
      messageCount,
      recentMessages,
      gamification,
      restrictions,
    ] = await Promise.all([
      this.prisma.modBillingOrder.findMany({
        where: { tenantId, userId },
        orderBy: { createdAt: 'desc' },
        take: RECENT,
      }),
      this.prisma.modSubscriptionsSubscription.findMany({
        where: { tenantId, userId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.modPaymentConnectionsSubscriber.findMany({
        where: { tenantId, userId },
        orderBy: { lastSeenAt: 'desc' },
        take: RECENT,
      }),
      this.prisma.modPaymentConnectionsOrder.findMany({
        where: { tenantId, userId },
        orderBy: { placedAt: 'desc' },
      }),
      this.prisma.modLearningEnrollment.findMany({
        where: { tenantId, userId },
        orderBy: { enrolledAt: 'desc' },
      }),
      this.prisma.modCertificatesIssued.findMany({
        where: { tenantId, userId },
        orderBy: { issuedAt: 'desc' },
        take: RECENT,
      }),
      this.prisma.modAssessmentsAttempt.findMany({
        where: { tenantId, userId },
        orderBy: { startedAt: 'desc' },
        take: RECENT,
      }),
      this.prisma.modZoomSessionAttendance.findMany({
        where: { tenantId, userId },
        orderBy: { joinedAt: 'desc' },
        take: RECENT,
      }),
      this.prisma.modCommunityPost.findMany({
        where: { tenantId, authorId: userId },
        orderBy: { createdAt: 'desc' },
        take: RECENT,
      }),
      this.prisma.modCommunityComment.findMany({
        where: { tenantId, authorId: userId },
        orderBy: { createdAt: 'desc' },
        take: RECENT,
      }),
      this.prisma.modCommunityReaction.count({ where: { tenantId, authorId: userId } }),
      this.prisma.modLearningLessonComment.count({ where: { tenantId, authorId: userId } }),
      this.prisma.modResourcesResource.count({ where: { tenantId, createdById: userId } }),
      this.prisma.modAiTutorTokenUsage.aggregate({
        where: { tenantId, userId },
        _sum: { questions: true },
      }),
      this.prisma.modMessagingMessage.count({ where: { tenantId, authorId: userId } }),
      this.prisma.modMessagingMessage.findMany({
        where: { tenantId, authorId: userId },
        orderBy: { createdAt: 'desc' },
        take: RECENT_MESSAGES,
        include: { conversation: { select: { type: true } } },
      }),
      this.prisma.modGamificationProfile.findFirst({ where: { tenantId, userId } }),
      this.restrictions.list(tenantId, userId),
    ]);

    // Títulos de curso en un solo viaje: los pedidos y las matrículas los
    // referencian por id y un expediente con UUIDs no se puede leer.
    const courseIds = [
      ...new Set([
        ...orders.map((o) => o.courseId),
        ...enrollments.map((e) => e.courseId),
        ...certificates.map((c) => c.courseId),
      ]),
    ];
    const courses = courseIds.length
      ? await this.prisma.modCoursesCourse.findMany({
          where: { id: { in: courseIds }, tenantId },
          select: { id: true, title: true },
        })
      : [];
    const titleOf = new Map(courses.map((c) => [c.id, c.title]));

    const planIds = [
      ...new Set(subscriptions.map((s) => s.planId).filter((v): v is string => !!v)),
    ];
    const plans = planIds.length
      ? await this.prisma.modSubscriptionsPlan.findMany({
          where: { id: { in: planIds }, tenantId },
          select: { id: true, name: true },
        })
      : [];
    const planOf = new Map(plans.map((p) => [p.id, p.name]));

    // Lo cobrado de verdad: completado y no devuelto.
    const totalPaidCents = orders
      .filter((o) => o.status === 'COMPLETED' && !o.refundedAt)
      .reduce((sum, o) => sum + (o.amountPaid ?? 0), 0);

    // Lo cobrado en la tienda externa. El espejo ya normalizó `paid`, así que
    // aquí no hay que volver a interpretar estados de WooCommerce.
    const totalPaidExternalCents = externalOrders
      .filter((o) => o.paid)
      .reduce((sum, o) => sum + o.totalAmount, 0);

    // La antigüedad real como cliente es su primera compra, no el día que
    // alguien le creó la cuenta. Tamara compró el 17 de julio y su cuenta se
    // creó el 28: sin esto, la ficha diría que lleva tres días.
    const primeraCompra = externalOrders
      .filter((o) => o.paid)
      .map((o) => o.placedAt)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.user.dossier_viewed',
      resourceType: 'user',
      resourceId: userId,
      // Deja explícito que esta consulta incluyó comunicaciones privadas.
      metadata: { includedPrivateMessages: true, messageCount },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return {
      identity: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        jobTitle: user.jobTitle,
        department: user.department,
        location: user.location,
        status: user.status,
        roles: user.roles.map((r) => r.role.name),
        emailVerified: user.emailVerified,
        mfaEnabled: user.mfaEnabled,
        locale: user.locale,
        timezone: user.timezone,
        documentId: user.documentId,
        externalSource: user.externalSource,
        externalId: user.externalId,
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
        membershipDays: daysBetween(user.createdAt, now),
      },
      commerce: {
        orders: orders.map((o) => ({
          id: o.id,
          courseId: o.courseId,
          courseTitle: titleOf.get(o.courseId) ?? null,
          status: o.status,
          amountPaid: o.amountPaid,
          currency: o.currency,
          completedAt: o.completedAt?.toISOString() ?? null,
          refundedAt: o.refundedAt?.toISOString() ?? null,
          createdAt: o.createdAt.toISOString(),
        })),
        totalPaidCents,
        subscriptions: subscriptions.map((s) => ({
          id: s.id,
          courseId: s.courseId,
          planName: s.planId ? (planOf.get(s.planId) ?? null) : null,
          status: s.status,
          unitAmount: s.unitAmount,
          currency: s.currency,
          interval: s.interval,
          currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
          canceledAt: s.canceledAt?.toISOString() ?? null,
          daysToRenewal: s.currentPeriodEnd ? daysBetween(now, s.currentPeriodEnd) : null,
        })),
        externalSubscriptions: externalSubs.map((s) => ({
          provider: s.provider,
          productName: s.productName,
          status: s.status,
          entitled: s.entitled,
          currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        })),
        externalOrders: externalOrders.map((o) => ({
          id: o.id,
          provider: o.provider,
          externalId: o.externalId,
          status: o.status,
          paid: o.paid,
          totalAmount: o.totalAmount,
          currency: o.currency,
          placedAt: o.placedAt.toISOString(),
          paidAt: o.paidAt?.toISOString() ?? null,
          refundedAt: o.refundedAt?.toISOString() ?? null,
          entitlementKind: o.entitlementKind,
          accessEndsAt: o.accessEndsAt?.toISOString() ?? null,
          daysToExpiry: o.accessEndsAt ? daysBetween(now, o.accessEndsAt) : null,
          products: productNamesOf(o.items),
        })),
        totalPaidExternalCents,
        customerSince: primeraCompra?.toISOString() ?? null,
      },
      learning: {
        enrollments: enrollments.map((e) => ({
          courseId: e.courseId,
          courseTitle: titleOf.get(e.courseId) ?? null,
          status: e.status,
          progressPercent: e.progressPercent,
          enrolledAt: e.enrolledAt.toISOString(),
          completedAt: e.completedAt?.toISOString() ?? null,
        })),
        certificates: certificates.map((c) => ({
          id: c.id,
          courseId: c.courseId,
          number: c.number,
          issuedAt: c.issuedAt.toISOString(),
          revokedAt: c.revokedAt?.toISOString() ?? null,
        })),
        quizAttempts: quizAttempts.map((a) => ({
          id: a.id,
          quizId: a.quizId,
          scorePercent: a.scorePercent,
          passed: a.passed,
          submittedAt: a.submittedAt?.toISOString() ?? null,
        })),
        liveAttendance: attendance.map((a) => ({
          sessionId: a.sessionId,
          present: a.present,
          minutes: a.minutes,
          joinedAt: a.joinedAt?.toISOString() ?? null,
        })),
      },
      activity: {
        counts: {
          posts: posts.length,
          comments: comments.length,
          reactions: reactionCount,
          messages: messageCount,
          lessonComments: lessonCommentCount,
          resources: resourceCount,
          aiQuestions: aiUsage._sum.questions ?? 0,
        },
        posts: posts.map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          createdAt: p.createdAt.toISOString(),
          hiddenAt: p.hiddenAt?.toISOString() ?? null,
          deletedAt: p.deletedAt?.toISOString() ?? null,
        })),
        comments: comments.map((c) => ({
          id: c.id,
          postId: c.postId,
          body: c.body,
          createdAt: c.createdAt.toISOString(),
          hiddenAt: c.hiddenAt?.toISOString() ?? null,
          deletedAt: c.deletedAt?.toISOString() ?? null,
        })),
      },
      messages: {
        total: messageCount,
        recent: recentMessages.map((m) => ({
          id: m.id,
          conversationId: m.conversationId,
          conversationType: m.conversation.type,
          body: m.body,
          kind: m.kind,
          createdAt: m.createdAt.toISOString(),
          deletedAt: m.deletedAt?.toISOString() ?? null,
        })),
      },
      gamification: gamification
        ? {
            lifetimePoints: gamification.lifetimePoints,
            levelKey: gamification.levelKey,
            levelReachedAt: gamification.levelReachedAt?.toISOString() ?? null,
          }
        : null,
      access: {
        recentSessions: user.sessions.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          ip: s.ip,
          userAgent: s.userAgent,
        })),
        externalIdentities: user.externalIdentities.map((i) => ({
          provider: i.provider,
          issuer: i.issuer,
          linkedAt: i.linkedAt.toISOString(),
          lastSeenAt: i.lastSeenAt?.toISOString() ?? null,
        })),
      },
      restrictions,
    };
  }
}
