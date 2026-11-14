/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MESSAGING_STAFF_ROLES } from '@didacta/mod-messaging';
import {
  MESSAGE_BODY_MAX,
  retentionLocale,
  type RetentionAcademy,
  type RetentionEmailOutcome,
  type RetentionEnrollmentSignal,
  type RetentionLink,
  type RetentionMember,
  type RetentionPorts,
  type RetentionReceipt,
  type RetentionStaffMember,
} from '@didacta/mod-retention';
import {
  academyLocale,
  academyTimeZone,
  type AcademyDefaultsPrisma,
} from '../../common/academy-defaults';
import { SUPPORT_USER_EMAIL } from '../../tenancy/support-access';
import { communityUnsubscribeUrl } from '../community/broadcast-unsubscribe';
import { MessagingRealtimePublisher } from '../messaging/messaging-realtime.publisher';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * El host de mod.retention: implementa sus puertos (ADR-039, opción B).
 *
 * - Mensajería y comunidad, por sus SERVICIOS públicos (enviar un directo,
 *   lecturas, baja de los correos de la comunidad).
 * - Miembros, matrículas, pagos, primera publicación y nivel: lecturas
 *   acotadas por `tenantId`, solo lectura, en el host (ADR-016 nivel 2), para
 *   que el módulo no toque nunca una tabla que no es suya.
 *
 * Todo corre bajo el contexto de aula de quien llama (petición, evento o
 * barrido con `runAsTenant`): con RLS forzada, una consulta fuera de él no ve
 * ni una fila.
 */

/** Quién NO recibe mensajes automáticos: el equipo y la inspección. */
const NOT_RECIPIENT_ROLES = new Set<string>([...MESSAGING_STAFF_ROLES, 'inspector']);
/** Quién puede firmarlos: primero quien administra, después el profesorado. */
const SENDER_ROLE_ORDER = ['tenant_admin', 'super_admin', 'formador'] as const;
/** Así llegan pagando: compra suelta, suscripción o venta por API. */
const PAID_SOURCES = new Set(['PURCHASE', 'SUBSCRIPTION', 'API']);
const CURRENT_SUBSCRIPTION = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

@Injectable()
export class RetentionHostPorts implements RetentionPorts, OnModuleInit {
  constructor(
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
    @Inject(forwardRef(() => ModuleContextFactory))
    private readonly factory: ModuleContextFactory,
    private readonly realtime: MessagingRealtimePublisher,
  ) {}

  onModuleInit(): void {
    this.registry.attachRetentionPorts(this);
  }

  private get prisma() {
    return this.factory.getPrisma();
  }

  async academy(tenantId: string): Promise<RetentionAcademy> {
    const prisma = this.prisma;
    const [tenant, locale, timezone, base, general] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      academyLocale(prisma as unknown as AcademyDefaultsPrisma, tenantId),
      academyTimeZone(prisma as unknown as AcademyDefaultsPrisma, tenantId),
      this.factory.getTenantWebBaseUrl(tenantId),
      prisma.modCommunitySpace.findFirst({
        where: { tenantId, slug: 'general' },
        select: { slug: true },
      }),
    ]);
    const web = trimBase(base);
    return {
      name: tenant?.name ?? '',
      locale: retentionLocale(locale),
      timezone,
      webBaseUrl: web,
      // «Preséntate»: el espacio General si existe (lo siembra el aula), si no
      // la portada de la comunidad, que siempre deja publicar.
      introUrl: general ? `${web}/spaces/${general.slug}` : `${web}/community`,
      communityUrl: `${web}/community`,
      coursesUrl: `${web}/courses`,
    };
  }

  private async usersAsMembers(tenantId: string, ids?: string[]): Promise<RetentionMember[]> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        timezone: true,
        createdAt: true,
        lastLoginAt: true,
        lastSeenAt: true,
        externalSource: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      timezone: u.timezone,
      joinedAt: u.createdAt,
      lastActiveAt: latest(u.lastLoginAt, u.lastSeenAt),
      isStaff:
        u.email === SUPPORT_USER_EMAIL || u.roles.some((r) => NOT_RECIPIENT_ROLES.has(r.role.name)),
      imported: u.externalSource !== null,
    }));
  }

  listMembers(tenantId: string): Promise<RetentionMember[]> {
    return this.usersAsMembers(tenantId);
  }

  async getMembers(tenantId: string, ids: string[]): Promise<RetentionMember[]> {
    if (ids.length === 0) return [];
    return this.usersAsMembers(tenantId, ids);
  }

  async listStaff(tenantId: string): Promise<RetentionStaffMember[]> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        email: { not: SUPPORT_USER_EMAIL },
        roles: { some: { role: { name: { in: [...SENDER_ROLE_ORDER] } } } },
      },
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        createdAt: true,
        roles: { select: { role: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const rank = (names: string[]) =>
      Math.min(
        ...names.map((n) => {
          const i = SENDER_ROLE_ORDER.indexOf(n as (typeof SENDER_ROLE_ORDER)[number]);
          return i === -1 ? SENDER_ROLE_ORDER.length : i;
        }),
      );
    return users
      .map((u) => ({ u, r: rank(u.roles.map((x) => x.role.name)) }))
      .sort((a, b) => a.r - b.r || a.u.createdAt.getTime() - b.u.createdAt.getTime())
      .map(({ u }) => ({ id: u.id, name: u.name?.trim() || u.email, avatarUrl: u.avatarUrl }));
  }

  isModuleEnabled(tenantId: string, moduleName: string): Promise<boolean> {
    return this.registry.isModuleEnabledForTenant(tenantId, moduleName);
  }

  async enrollmentSignals(
    tenantId: string,
    userIds?: string[],
  ): Promise<RetentionEnrollmentSignal[]> {
    if (userIds && userIds.length === 0) return [];
    const prisma = this.prisma;
    const enrollments = await prisma.modLearningEnrollment.findMany({
      where: {
        tenantId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
        ...(userIds ? { userId: { in: userIds } } : {}),
      },
      select: {
        id: true,
        userId: true,
        courseId: true,
        source: true,
        enrolledAt: true,
        startedAt: true,
        completedAt: true,
        progressPercent: true,
      },
    });
    if (enrollments.length === 0) return [];
    const courseIds = [...new Set(enrollments.map((e) => e.courseId))];
    const [courses, activity, base] = await Promise.all([
      prisma.modCoursesCourse.findMany({
        where: { tenantId, id: { in: courseIds }, deletedAt: null },
        select: { id: true, title: true, slug: true },
      }),
      prisma.modLearningProgress.groupBy({
        by: ['enrollmentId'],
        where: { tenantId, enrollmentId: { in: enrollments.map((e) => e.id) } },
        _max: { lastAccessedAt: true },
      }),
      this.factory.getTenantWebBaseUrl(tenantId),
    ]);
    const web = trimBase(base);
    const courseById = new Map(courses.map((c) => [c.id, c]));
    const lastById = new Map(activity.map((a) => [a.enrollmentId, a._max.lastAccessedAt]));
    const out: RetentionEnrollmentSignal[] = [];
    for (const e of enrollments) {
      const course = courseById.get(e.courseId);
      if (!course) continue;
      out.push({
        userId: e.userId,
        courseId: e.courseId,
        courseTitle: course.title,
        courseUrl: `${web}/courses/${encodeURIComponent(course.slug)}`,
        paid: PAID_SOURCES.has(e.source),
        enrolledAt: e.enrolledAt,
        startedAt: e.startedAt,
        completedAt: e.completedAt,
        progressPercent: e.progressPercent,
        lastActivityAt: lastById.get(e.id) ?? null,
      });
    }
    return out;
  }

  private async linkOf(
    tenantId: string,
    course: { title: string; slug: string } | null,
  ): Promise<RetentionLink | null> {
    if (!course) return null;
    const web = trimBase(await this.factory.getTenantWebBaseUrl(tenantId));
    return { title: course.title, url: `${web}/courses/${encodeURIComponent(course.slug)}` };
  }

  async firstPublishedCourse(tenantId: string): Promise<RetentionLink | null> {
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, status: 'PUBLISHED', deletedAt: null },
      orderBy: [{ publishedAt: 'asc' }, { createdAt: 'asc' }],
      select: { title: true, slug: true },
    });
    return this.linkOf(tenantId, course);
  }

  async courseLink(tenantId: string, courseId: string): Promise<RetentionLink | null> {
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, id: courseId, deletedAt: null },
      select: { title: true, slug: true },
    });
    return this.linkOf(tenantId, course);
  }

  async levelName(tenantId: string, userId: string): Promise<string | null> {
    const profile = await this.prisma.modGamificationProfile.findFirst({
      where: { tenantId, userId },
      select: { levelKey: true },
    });
    if (!profile?.levelKey) return null;
    const level = await this.prisma.modGamificationLevel.findFirst({
      where: { tenantId, key: profile.levelKey },
      select: { name: true },
    });
    return level?.name ?? null;
  }

  async paidAccess(tenantId: string): Promise<Array<{ userId: string; paidAt: Date }>> {
    const [orders, subscriptions] = await Promise.all([
      this.prisma.modBillingOrder.findMany({
        where: { tenantId, status: 'COMPLETED', refundedAt: null, userId: { not: null } },
        select: { userId: true, completedAt: true, createdAt: true },
      }),
      this.prisma.modSubscriptionsSubscription.findMany({
        where: { tenantId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
        select: { userId: true, createdAt: true },
      }),
    ]);
    return [
      ...orders.map((o) => ({ userId: o.userId as string, paidAt: o.completedAt ?? o.createdAt })),
      ...subscriptions.map((s) => ({ userId: s.userId, paidAt: s.createdAt })),
    ];
  }

  async subscriptionStarts(tenantId: string): Promise<Array<{ userId: string; startedAt: Date }>> {
    const rows = await this.prisma.modSubscriptionsSubscription.findMany({
      where: { tenantId, status: { in: [...CURRENT_SUBSCRIPTION] } },
      select: { userId: true, createdAt: true },
    });
    return rows.map((r) => ({ userId: r.userId, startedAt: r.createdAt }));
  }

  async isFirstPost(tenantId: string, authorId: string, postId: string): Promise<boolean> {
    // Cuenta también las borradas: quien borró su primera publicación y escribe
    // otra no está publicando por primera vez.
    const first = await this.prisma.modCommunityPost.findFirst({
      where: { tenantId, authorId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return first?.id === postId;
  }

  async sendDirectMessage(
    tenantId: string,
    senderId: string,
    toUserId: string,
    body: string,
  ): Promise<{ conversationId: string; messageId: string }> {
    const sender = await this.prisma.user.findFirst({
      where: { id: senderId, tenantId },
      select: {
        name: true,
        email: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!sender) throw new Error('mod.retention: quien firma ya no existe en el aula');
    const caller = {
      userId: senderId,
      displayName: sender.name?.trim() || sender.email,
      roles: sender.roles.map((r) => r.role.name),
    };
    const messaging = this.registry.getMessagingService();
    const { conversationId } = await messaging.openDm(tenantId, caller, toUserId);
    const result = await messaging.sendMessage(
      tenantId,
      caller,
      conversationId,
      body.slice(0, MESSAGE_BODY_MAX),
    );
    // El mismo push que si lo hubiera escrito a mano: le aparece al momento.
    await this.realtime.publishToUsers(tenantId, [...result.recipientUserIds, senderId], {
      kind: 'message.created',
      conversationId,
      message: result.message,
    });
    return { conversationId, messageId: result.message.id };
  }

  recentDirectMessages(
    tenantId: string,
    authorIds: string[],
    toUserId: string,
    since: Date,
  ): Promise<Array<{ messageId: string; createdAt: Date }>> {
    return this.registry
      .getMessagingService()
      .recentDirectMessagesTo(tenantId, authorIds, toUserId, since);
  }

  receipts(
    tenantId: string,
    items: Array<{ conversationId: string; userId: string; since: Date }>,
  ): Promise<RetentionReceipt[]> {
    return this.registry.getMessagingService().readReceipts(tenantId, items);
  }

  async sendEmail(
    tenantId: string,
    toUserId: string,
    message: { subject: string; body: string },
  ): Promise<RetentionEmailOutcome> {
    // La baja de los correos de la comunidad (enlace de un correo o el
    // interruptor de su cuenta) vale también para estos.
    const prefs = await this.registry.getCommunityService().getUserPreferences(tenantId, toUserId);
    if (prefs.digestOptOut) return 'opted_out';
    const pref = await this.prisma.userNotificationPreference.findUnique({
      where: {
        tenantId_userId_category_channel: {
          tenantId,
          userId: toUserId,
          category: 'COMMUNITY',
          channel: 'EMAIL',
        },
      },
      select: { enabled: true },
    });
    if (pref && !pref.enabled) return 'preference_off';
    const user = await this.prisma.user.findFirst({
      where: { id: toUserId, tenantId },
      select: { email: true },
    });
    if (!user?.email) return 'no_address';
    const web = trimBase(await this.factory.getTenantWebBaseUrl(tenantId));
    await this.factory.getNotificationHub().send({
      tenantId,
      channel: 'email',
      templateKey: 'retention.message',
      to: toUserId,
      category: 'COMMUNITY',
      variables: {
        subject: message.subject,
        body: message.body,
        replyUrl: web ? `${web}/messages` : '',
        unsubUrl: communityUnsubscribeUrl(web, tenantId, toUserId),
      },
    });
    return 'sent';
  }
}
