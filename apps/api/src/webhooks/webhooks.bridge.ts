/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * WebhooksBridge — suscribe handlers al EventBus para reenviar eventos
 * a los endpoints de webhook salientes configurados por cada tenant.
 *
 * Diseño:
 *   - Suscripción única por tipo de evento conocido (lista en
 *     webhooks.types.ts → KNOWN_EVENT_TYPES). Cada handler delega al
 *     `WebhooksService.dispatch(tenantId, eventType, payload)`.
 *   - El service decide tier (community / enterprise) en runtime y aplica
 *     el path correspondiente. El bridge NO conoce la división.
 *   - Si el dispatch falla (ej. todas las entregas naive fallan), NO
 *     re-throw — el outbox marca el evento como procesado igual. Webhooks
 *     son best-effort (nunca bloquean la lógica de negocio).
 *
 * Idempotencia: el outbox dedupe por idempotencyKey. Si un evento se
 * reentrega (recovery worker), los webhooks salientes pueden recibir
 * duplicados. El receptor deduplica por `X-Didacta-Delivery`, y para que eso
 * sea posible el bridge le pasa al service el `idempotencyKey` del evento:
 * de ahí sale el `deliveryId`, que es el MISMO en la reentrega. Pasarle
 * también `metadata.userId` y `metadata.timestamp` es lo que permite al
 * service resolver la identidad del alumno y fechar el evento por cuándo
 * ocurrió, no por cuándo se envió.
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../modules/module-context.factory';
import { WebhooksService } from './webhooks.service';
import { KNOWN_EVENT_TYPES } from './webhooks.types';

@Injectable()
export class WebhooksBridge implements OnModuleInit {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly webhooks: WebhooksService,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();

    // Nos suscribimos a cada evento conocido. Excluimos `'*'` que es solo
    // marcador de suscripción "all" para los endpoints de webhook (no es
    // un nombre de evento real publicado por nadie).
    for (const eventType of KNOWN_EVENT_TYPES) {
      if (eventType === '*') continue;
      eventBus.subscribe(eventType, async (event) => {
        const tenantId = event.metadata.tenantId;
        if (!tenantId) return;
        try {
          await this.webhooks.dispatch(tenantId, event.name, event.data, {
            actorUserId: event.metadata.userId,
            occurredAt: event.metadata.timestamp,
            idempotencyKey: event.metadata.idempotencyKey,
          });
        } catch (err) {
          this.logger.warn(
            { err: (err as Error).message, eventType: event.name, tenantId },
            'WebhooksBridge: dispatch falló — continuamos (best-effort)',
          );
        }
      });
    }

    this.logger.log(`WebhooksBridge: suscrito a ${KNOWN_EVENT_TYPES.length - 1} tipos de eventos`);
  }
}
