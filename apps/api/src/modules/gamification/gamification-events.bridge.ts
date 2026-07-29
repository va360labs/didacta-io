import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

const MODULE_NAME = 'mod.gamification';

/**
 * Convierte los eventos que YA circulaban por el bus en asientos de puntos.
 *
 * Vive en el host, no en el módulo: el emisor no debe conocer al consumidor y
 * la composición cross-módulo es responsabilidad del host (ADR-016, mismo
 * patrón que SurveysZoomBridge).
 *
 * Dos cosas importantes:
 *
 * 1. GATING POR TENANT. Desactivar un módulo NO apaga el bus: las suscripciones
 *    se hacen una vez por proceso en `onRegister` y `onDisable` no desuscribe
 *    nada. Sin esta comprobación, un tenant que apaga los puntos seguiría
 *    acumulándolos por detrás.
 *
 * 2. IDEMPOTENCIA. La entrega es AL MENOS UNA VEZ y la `idempotencyKey` del
 *    outbox lleva Date.now(), así que no deduplica aguas abajo. Por eso cada
 *    asiento va con una `sourceKey` derivada de la ENTIDAD, y la unique del
 *    ledger es la que corta el doble cobro.
 *
 * Todo es best-effort: un fallo aquí nunca rompe la operación que originó el
 * evento (publicar un post, terminar un curso…).
 */
@Injectable()
export class GamificationEventsBridge implements OnModuleInit {
  private readonly logger = new Logger(GamificationEventsBridge.name);

  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    const bus = this.factory.getEventBus();

    bus.subscribe<{ postId: string; authorId: string }>('community.post.created', async (event) => {
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        const post = await this.prisma.modCommunityPost.findFirst({
          where: { id: event.data.postId, tenantId },
          select: { id: true, authorId: true, createdAt: true, source: true },
        });
        if (!post) return;
        // Los posts publicados con API key no puntúan: son integraciones, no
        // participación. El ranking anterior sí los contaba (era un agujero).
        if (post.source === 'api') return;
        await this.award({
          tenantId,
          userId: post.authorId,
          ruleKey: 'community.post',
          sourceKey: `community.post:${post.id}`,
          occurredAt: post.createdAt,
          meta: { postId: post.id },
        });
      });
    });

    bus.subscribe<{ commentId: string; postId: string; authorId: string }>(
      'community.comment.created',
      async (event) => {
        await this.guard(event.metadata.tenantId, async (tenantId) => {
          const comment = await this.prisma.modCommunityComment.findFirst({
            where: { id: event.data.commentId, tenantId },
            select: { id: true, authorId: true, createdAt: true, postId: true },
          });
          if (!comment) return;
          await this.award({
            tenantId,
            userId: comment.authorId,
            ruleKey: 'community.comment',
            sourceKey: `community.comment:${comment.id}`,
            occurredAt: comment.createdAt,
            meta: { commentId: comment.id, postId: comment.postId },
          });
        });
      },
    );

    // Moderar retira los puntos: publicar, cobrar y que lo oculten no puede
    // salir gratis. Estos dos eventos ya se emitían y nadie los escuchaba.
    bus.subscribe<{ postId: string }>('community.post.hidden', async (event) => {
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        await this.revoke(
          tenantId,
          `community.post:${event.data.postId}`,
          'post oculto por moderación',
        );
      });
    });

    bus.subscribe<{ commentId: string }>('community.comment.hidden', async (event) => {
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        await this.revoke(
          tenantId,
          `community.comment:${event.data.commentId}`,
          'comentario oculto por moderación',
        );
      });
    });

    bus.subscribe<{ resourceId: string }>('resources.resource.created', async (event) => {
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        const resource = await this.prisma.modResourcesResource.findFirst({
          where: { id: event.data.resourceId, tenantId },
          select: { id: true, createdById: true, createdAt: true, title: true },
        });
        if (!resource) return;
        await this.award({
          tenantId,
          userId: resource.createdById,
          ruleKey: 'resources.shared',
          sourceKey: `resources.shared:${resource.id}`,
          occurredAt: resource.createdAt,
          meta: { resourceId: resource.id, title: resource.title },
        });
      });
    });

    bus.subscribe<{ resourceId: string }>('resources.resource.deleted', async (event) => {
      await this.guard(event.metadata.tenantId, async (tenantId) => {
        await this.revoke(
          tenantId,
          `resources.shared:${event.data.resourceId}`,
          'recurso eliminado',
        );
      });
    });

    bus.subscribe<{ enrollmentId: string; courseId: string; userId: string }>(
      'learning.course.completed',
      async (event) => {
        await this.guard(event.metadata.tenantId, async (tenantId) => {
          // La clave es la matrícula, no el evento: mod.learning puede emitirlo
          // dos veces en una carrera concurrente (lee completedAt sin lock).
          await this.award({
            tenantId,
            userId: event.data.userId,
            ruleKey: 'learning.course',
            sourceKey: `learning.course:${event.data.enrollmentId}`,
            meta: { courseId: event.data.courseId },
          });
        });
      },
    );

    bus.subscribe<{ referralId: string; referrerUserId: string }>(
      'referrals.referral.attributed',
      async (event) => {
        await this.guard(event.metadata.tenantId, async (tenantId) => {
          // Se puntúa la atribución (una vez por referido), no la comisión, que
          // se devenga en cada factura recurrente.
          await this.award({
            tenantId,
            userId: event.data.referrerUserId,
            ruleKey: 'referrals.converted',
            sourceKey: `referrals.converted:${event.data.referralId}`,
            meta: { referralId: event.data.referralId },
          });
        });
      },
    );

    this.logger.log('Gamificación suscrita a 8 eventos del bus');
  }

  /** Ejecuta el handler solo si el tenant tiene el módulo activo. Best-effort. */
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
        `Gamificación: fallo procesando un evento del tenant ${tenantId}: ${String(error)}`,
      );
    }
  }

  private async award(args: {
    tenantId: string;
    userId: string;
    ruleKey: string;
    sourceKey: string;
    occurredAt?: Date;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.registry.getGamificationService().award(args);
  }

  private async revoke(tenantId: string, sourceKey: string, reason: string): Promise<void> {
    await this.registry.getGamificationService().revoke({ tenantId, sourceKey, reason });
  }
}
