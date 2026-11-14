/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  celebrationLocale,
  isCelebrationBody,
  renderCelebration,
  type CelebrationEntry,
  type CelebrationKind,
  type UnlockedContent,
} from '@didacta/mod-gamification';
import { AlreadyEnrolledError } from '@didacta/mod-learning';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';
import { GamificationRetentionHost } from './gamification-retention.host';

const MODULE_NAME = 'mod.gamification';

/**
 * Retención de mod.gamification: convierte los hechos que YA circulan por el
 * bus en rachas, insignias, premios, contenido desbloqueado y celebraciones.
 *
 * Vive en el host por la misma razón que `GamificationEventsBridge`: la
 * composición entre módulos (comunidad, aprendizaje, cursos) es cosa de la capa
 * de composición. Las DECISIONES las toma el módulo (`RetentionService`); aquí
 * solo se le pasan los datos del core y se ejecutan sus efectos con los
 * servicios públicos de los demás módulos (publicar un post, matricular).
 *
 * Todo best-effort y con gating por tenant: un fallo nunca rompe la operación
 * que originó el evento, y un aula con los puntos apagados no acumula nada.
 */
@Injectable()
export class GamificationRetentionBridge implements OnModuleInit {
  private readonly logger = new Logger(GamificationRetentionBridge.name);

  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly host: GamificationRetentionHost,
  ) {}

  onModuleInit(): void {
    const bus = this.factory.getEventBus();

    bus.subscribe<{ postId: string }>('community.post.created', async (event) => {
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        const post = await this.prisma.modCommunityPost.findFirst({
          where: { id: event.data.postId, tenantId },
          select: { id: true, authorId: true, createdAt: true, source: true, body: true },
        });
        // Integraciones y las propias celebraciones no son participación.
        if (!post || post.source === 'api' || isCelebrationBody(post.body)) return;
        await this.onParticipation(tenantId, post.authorId, post.createdAt, {
          sourceKey: `community.post:${post.id}`,
          posted: true,
        });
      });
    });

    bus.subscribe<{ commentId: string }>('community.comment.created', async (event) => {
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        const comment = await this.prisma.modCommunityComment.findFirst({
          where: { id: event.data.commentId, tenantId },
          select: { id: true, authorId: true, createdAt: true },
        });
        if (!comment) return;
        await this.onParticipation(tenantId, comment.authorId, comment.createdAt, {
          sourceKey: `community.comment:${comment.id}`,
          commented: true,
        });
      });
    });

    // Avanzar en un curso también es un día activo (y alimenta la racha).
    bus.subscribe<{ enrollmentId: string }>('learning.progress.updated', async (event) => {
      const userId = event.metadata.userId;
      if (!userId) return;
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        const member = await this.host.member(tenantId, userId);
        if (!member) return;
        const retention = this.registry.getRetentionService();
        const { newDay } = await retention.recordActivity(
          tenantId,
          userId,
          new Date(),
          member.timeZone,
        );
        if (newDay) await retention.evaluateBadges(tenantId, userId);
      });
    });

    bus.subscribe<{ enrollmentId: string; courseId: string; userId: string }>(
      'learning.course.completed',
      async (event) => {
        await this.guard(event.metadata.tenantId, async (tenantId) => {
          const { userId, courseId } = event.data;
          const member = await this.host.member(tenantId, userId);
          if (!member) return;
          const retention = this.registry.getRetentionService();
          await retention.recordActivity(tenantId, userId, new Date(), member.timeZone);
          await retention.evaluateBadges(tenantId, userId, { completedCourse: true });
          if (member.isStaff) return;
          const course = await this.host.course(tenantId, courseId);
          if (!course) return;
          await this.celebrate(tenantId, 'course', `${userId}:${courseId}`, {
            userId,
            name: member.name,
            detail: course.title,
          });
        });
      },
    );

    // Cada punto puede cruzar el umbral de un premio por puntos.
    bus.subscribe<{ userId: string }>('gamification.points.awarded', async (event) => {
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        await this.registry.getRetentionService().grantDueRewards(tenantId, event.data.userId);
      });
    });

    bus.subscribe<{ userId: string; from: string | null; to: string; levelName: string }>(
      'gamification.level.changed',
      async (event) => {
        await this.guard(event.metadata.tenantId, async (tenantId) => {
          const { userId, from, to, levelName } = event.data;
          const retention = this.registry.getRetentionService();
          // Lo que estaba por encima del nivel anterior y ya no lo está.
          const previous = from
            ? await this.prisma.modGamificationLevel.findUnique({
                where: { tenantId_key: { tenantId, key: from } },
                select: { minPoints: true },
              })
            : null;
          await retention.collectUnlocks(tenantId, userId, previous?.minPoints ?? null);
          await retention.grantDueRewards(tenantId, userId);
          await retention.evaluateBadges(tenantId, userId);
          const member = await this.host.member(tenantId, userId);
          if (!member || member.isStaff) return;
          await this.celebrate(tenantId, 'level', `${userId}:${to}`, {
            userId,
            name: member.name,
            detail: levelName,
          });
        });
      },
    );

    bus.subscribe<UnlockedContent & { userId: string }>(
      'gamification.content.unlocked',
      async (event) => {
        await this.guard(event.metadata.tenantId, async (tenantId) => {
          await this.onUnlocked(tenantId, event.data);
        });
      },
    );

    this.logger.log('Retención de gamificación suscrita a 7 eventos del bus');
  }

  /** Lo llama el job diario de aniversarios (no hay evento de «cumpleaños»). */
  async celebrateAnniversary(
    tenantId: string,
    who: { userId: string; name: string; years: number; year: number },
  ): Promise<void> {
    await this.celebrate(tenantId, 'anniversary', `${who.userId}:${who.year}`, {
      userId: who.userId,
      name: who.name,
      detail: String(who.years),
    });
  }

  /** Un post o comentario: día activo, insignias y, si es su estreno, bienvenida. */
  private async onParticipation(
    tenantId: string,
    userId: string,
    at: Date,
    fact: { sourceKey: string; posted?: boolean; commented?: boolean },
  ): Promise<void> {
    const member = await this.host.member(tenantId, userId);
    if (!member) return;
    const retention = this.registry.getRetentionService();
    await retention.recordActivity(tenantId, userId, at, member.timeZone);
    await retention.evaluateBadges(tenantId, userId, {
      posted: fact.posted,
      commented: fact.commented,
    });
    if (member.isStaff) return;
    if (!(await retention.isFirstParticipation(tenantId, userId, fact.sourceKey, at))) return;
    await this.celebrate(tenantId, 'intro', userId, { userId, name: member.name });
  }

  /**
   * Lo que se acaba de abrir. Si es un curso entero y la persona aún no está
   * matriculada, se la matricula SOLO si el curso es gratis o si el creador
   * marcó «regalarlo al llegar al nivel»: el nivel nunca regala por sí solo lo
   * que se vende. El aviso solo sale si de verdad puede entrar.
   */
  private async onUnlocked(
    tenantId: string,
    unlocked: UnlockedContent & { userId: string },
  ): Promise<void> {
    const course = await this.host.course(tenantId, unlocked.courseId);
    if (!course || course.status !== 'PUBLISHED') return;
    const learning = this.registry.getLearningService();
    let enrolled = await learning.hasActiveEnrollment(tenantId, unlocked.userId, course.id);

    if (!enrolled && unlocked.targetKind === 'COURSE') {
      const sold =
        course.externalPurchaseUrl !== null ||
        (await this.registry.isCourseSold(tenantId, course.id));
      if (!sold || unlocked.grantPaid) {
        try {
          await learning.enrollByAdmin(tenantId, null, {
            userId: unlocked.userId,
            courseId: course.id,
          });
        } catch (err) {
          if (!(err instanceof AlreadyEnrolledError)) throw err;
        }
        enrolled = true;
      }
    }
    if (!enrolled) return;

    const hub = this.factory.getNotificationHub();
    for (const channel of ['in-app', 'email'] as const) {
      try {
        await hub.send({
          tenantId,
          channel,
          templateKey: 'gamification.content.unlocked',
          to: unlocked.userId,
          variables: {
            courseTitle: course.title,
            levelName: unlocked.levelName,
            courseSlug: course.slug,
          },
          category: 'COMMUNITY',
        });
      } catch (err) {
        this.logger.warn(`retención: fallo avisando del desbloqueo (${channel}): ${String(err)}`);
      }
    }
  }

  /**
   * Celebra un hecho en la comunidad: un post por tipo y día que nombra a todos
   * los del día. El módulo decide si se celebra y si toca crear o repintar el
   * post; aquí se publica con el servicio público de mod.community, firmado por
   * quien administra el aula y como `source: 'api'` (no puntúa).
   */
  private async celebrate(
    tenantId: string,
    kind: CelebrationKind,
    subjectKey: string,
    entry: CelebrationEntry,
  ): Promise<void> {
    if (!(await this.registry.isModuleEnabledForTenant(tenantId, 'mod.community'))) return;
    const author = await this.host.celebrationAuthor(tenantId);
    if (!author) return;
    const retention = this.registry.getRetentionService();
    const plan = await retention.planCelebration(
      tenantId,
      kind,
      subjectKey,
      entry,
      GamificationRetentionHost.utcDay(new Date()),
    );
    if (plan.action === 'skip' || plan.action === 'wait') return;

    const locale = celebrationLocale(await this.host.locale(tenantId));
    const community = this.registry.getCommunityService();
    const repaint = async (postId: string, entries: CelebrationEntry[]) => {
      const { title, body } = renderCelebration(kind, entries, locale);
      await community.updatePost(tenantId, { id: author.id, canModerate: true }, postId, {
        title,
        body,
      });
    };

    if (plan.action === 'update' && plan.postId) {
      try {
        await repaint(plan.postId, plan.entries);
      } catch (err) {
        // El creador pudo borrar el post del día: no se recrea, se registra.
        this.logger.warn(
          `retención: no se pudo repintar la celebración ${plan.postId}: ${String(err)}`,
        );
      }
      return;
    }

    try {
      const { title, body } = renderCelebration(kind, plan.entries, locale);
      const post = await community.createPost(
        tenantId,
        author,
        { title, body, tags: ['general'], notifyAll: false, important: false },
        'api',
      );
      const entries = await retention.attachCelebrationPost(tenantId, plan.celebrationId, post.id);
      // Llegó alguien más mientras se publicaba: se repinta con todos.
      if (entries.length !== plan.entries.length) await repaint(post.id, entries);
    } catch (err) {
      await retention.releaseCelebrationClaim(tenantId, plan.celebrationId);
      throw err;
    }
  }

  private async guard(
    tenantId: string | undefined,
    handler: (tenantId: string) => Promise<void>,
  ): Promise<void> {
    if (!tenantId) return;
    try {
      if (!(await this.registry.isModuleEnabledForTenant(tenantId, MODULE_NAME))) return;
      await handler(tenantId);
    } catch (error) {
      this.logger.warn(
        `Retención: fallo procesando un evento del tenant ${tenantId}: ${String(error)}`,
      );
    }
  }
}
