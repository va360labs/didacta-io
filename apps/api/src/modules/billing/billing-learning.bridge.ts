import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AlreadyEnrolledError } from '@didacta/mod-learning';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Puente entre mod.billing y mod.learning: cuando una orden Stripe se
 * confirma como COMPLETED (vía webhook idempotente), enrolla al alumno en
 * el curso comprado.
 *
 * Se subscribe al EventBus al boot. Si el alumno ya estaba enrollado
 * (ej. webhook duplicado o compra repetida), `enrollFromPurchase` lanzaría
 * `AlreadyEnrolledError` — lo capturamos como no-op (situación esperada).
 *
 * No cruza FKs: solo IDs lógicos. Cumple la regla 3 del contrato modular.
 */
interface BillingOrderCompletedPayload {
  orderId: string;
  productId: string;
  courseId: string;
  userId: string;
  amountPaid: number | null;
  currency: string;
  customerEmail: string | null;
}

@Injectable()
export class BillingLearningBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();
    eventBus.subscribe<BillingOrderCompletedPayload>(
      'billing.order.completed',
      async (event: DomainEvent<BillingOrderCompletedPayload>) => {
        await this.enroll(event);
      },
    );
    this.logger.log({}, 'BillingLearningBridge: subscribed to billing.order.completed');
  }

  async enroll(event: DomainEvent<BillingOrderCompletedPayload>): Promise<void> {
    const { courseId, userId, orderId } = event.data;
    const tenantId = event.metadata.tenantId;

    try {
      await this.registry.getLearningService().enrollFromPurchase(tenantId, userId, courseId);
      this.logger.log(
        { tenantId, userId, courseId, orderId },
        'BillingLearningBridge: enrolled after purchase',
      );
    } catch (err) {
      if (err instanceof AlreadyEnrolledError) {
        this.logger.warn(
          { tenantId, userId, courseId, orderId },
          'BillingLearningBridge: usuario ya enrolled — no-op (probable webhook duplicado)',
        );
        return;
      }
      // Cualquier otro error sí lo dejamos propagar — el outbox dispatcher
      // reintentará el evento. Si la causa es un curso despublicado o
      // borrado, el siguiente reintento fallará igual y quedará en DLQ.
      this.logger.error(
        {
          tenantId,
          userId,
          courseId,
          orderId,
          error: (err as Error).message,
        },
        'BillingLearningBridge: fallo al enrollar tras compra',
      );
      throw err;
    }
  }
}
