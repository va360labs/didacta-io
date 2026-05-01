import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AlreadyEnrolledError } from '@didacta/mod-learning';
import { ModuleContextFactory } from './module-context.factory';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Puente entre mod.subscriptions y mod.learning. Tres operaciones según evento:
 *
 *   - subscriptions.subscription.activated → enrolla al alumno en el curso
 *     (source SUBSCRIPTION). Idempotente vs AlreadyEnrolled (recovery desde
 *     PAST_DUE/UNPAID lanza activated otra vez con `recovery: true` y debe
 *     no hacer nada si ya está enrolled).
 *
 *   - subscriptions.subscription.unpaid → pausa enrollment (grace expirado).
 *     mod.learning.pauseEnrollment retira acceso a las lecciones pero NO
 *     borra el progreso — si el alumno renueva, vuelve donde se quedó.
 *
 *   - subscriptions.subscription.canceled (immediate=true) → desenrolla.
 *     Esto sí borra el enrollment activo. La cancelación at-period-end NO
 *     emite este evento hasta que el periodo expira (Stripe envía
 *     subscription.deleted al cierre).
 *
 * No cruza FKs entre tablas de módulos: solo IDs lógicos. Cumple regla 3.
 */

interface SubscriptionEventPayload {
  subscriptionId: string;
  courseId: string;
  userId: string;
  recovery?: boolean;
  immediate?: boolean;
}

@Injectable()
export class SubscriptionsLearningBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();

    eventBus.subscribe<SubscriptionEventPayload>(
      'subscriptions.subscription.activated',
      async (event: DomainEvent<SubscriptionEventPayload>) => {
        await this.onActivated(event);
      },
    );

    eventBus.subscribe<SubscriptionEventPayload>(
      'subscriptions.subscription.unpaid',
      async (event: DomainEvent<SubscriptionEventPayload>) => {
        await this.onUnpaid(event);
      },
    );

    eventBus.subscribe<SubscriptionEventPayload>(
      'subscriptions.subscription.canceled',
      async (event: DomainEvent<SubscriptionEventPayload>) => {
        await this.onCanceled(event);
      },
    );

    this.logger.log({}, 'SubscriptionsLearningBridge: subscribed to subscription events');
  }

  async onActivated(event: DomainEvent<SubscriptionEventPayload>): Promise<void> {
    const { courseId, userId, subscriptionId } = event.data;
    const tenantId = event.metadata.tenantId;
    try {
      await this.registry.getLearningService().enrollFromSubscription(tenantId, userId, courseId);
      this.logger.log(
        { tenantId, userId, courseId, subscriptionId, recovery: event.data.recovery ?? false },
        'SubscriptionsLearningBridge: enrolled after subscription activated',
      );
    } catch (err) {
      if (err instanceof AlreadyEnrolledError) {
        // Recovery desde PAST_DUE → ya estaba enrolled. Re-activamos por si
        // estaba pausado.
        await this.registry
          .getLearningService()
          .resumeEnrollment(tenantId, userId, courseId)
          .catch(() => {
            // Si no había pausa, ignoramos.
          });
        this.logger.log(
          { tenantId, userId, courseId, subscriptionId },
          'SubscriptionsLearningBridge: ya enrolled — resume si pausado',
        );
        return;
      }
      this.logger.error(
        { tenantId, userId, courseId, subscriptionId, error: (err as Error).message },
        'SubscriptionsLearningBridge: fallo al enrollar tras activación',
      );
      throw err;
    }
  }

  async onUnpaid(event: DomainEvent<SubscriptionEventPayload>): Promise<void> {
    const { courseId, userId, subscriptionId } = event.data;
    const tenantId = event.metadata.tenantId;
    try {
      await this.registry.getLearningService().pauseEnrollment(tenantId, userId, courseId);
      this.logger.log(
        { tenantId, userId, courseId, subscriptionId },
        'SubscriptionsLearningBridge: enrollment paused (grace expired)',
      );
    } catch (err) {
      this.logger.error(
        { tenantId, userId, courseId, subscriptionId, error: (err as Error).message },
        'SubscriptionsLearningBridge: fallo al pausar enrollment',
      );
      throw err;
    }
  }

  async onCanceled(event: DomainEvent<SubscriptionEventPayload>): Promise<void> {
    const { courseId, userId, subscriptionId, immediate } = event.data;
    const tenantId = event.metadata.tenantId;
    if (!immediate) {
      // Cancelación at-period-end: no tocamos enrollment todavía. Stripe nos
      // mandará subscription.deleted al cierre del periodo y entonces sí.
      this.logger.log(
        { tenantId, userId, courseId, subscriptionId },
        'SubscriptionsLearningBridge: canceled at-period-end — esperando deletion',
      );
      return;
    }
    try {
      await this.registry.getLearningService().unenrollFromSubscription(tenantId, userId, courseId);
      this.logger.log(
        { tenantId, userId, courseId, subscriptionId },
        'SubscriptionsLearningBridge: unenrolled after subscription canceled',
      );
    } catch (err) {
      this.logger.error(
        { tenantId, userId, courseId, subscriptionId, error: (err as Error).message },
        'SubscriptionsLearningBridge: fallo al desenrolar',
      );
      throw err;
    }
  }
}
