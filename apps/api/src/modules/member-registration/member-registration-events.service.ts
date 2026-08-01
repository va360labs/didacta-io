/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';

/** Eventos que emite mod.member-registration (declarados en su manifest). */
export type MemberRegistrationEventName =
  | 'member_registration.request.created'
  | 'member_registration.request.approved'
  | 'member_registration.request.rejected';

/**
 * Emisor de los eventos del módulo hacia el outbox (PersistentEventBus).
 *
 * Best-effort A PROPÓSITO: el evento se publica DESPUÉS de que la transacción
 * de negocio quedara persistida (solicitud creada / decisión sellada), así que
 * un fallo del outbox no debe revertir ni romper el flujo — se loguea warn y
 * se sigue. La clave de idempotencia es ÚNICA POR OCURRENCIA (patrón del
 * publisher de subscriptions): el outbox dedupea para siempre por
 * (tenantId, idempotencyKey) y una misma solicitud puede re-emitir el mismo
 * nombre de evento en momentos distintos de su vida.
 */
@Injectable()
export class MemberRegistrationEventsService {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  async publish(
    tenantId: string,
    userId: string,
    name: MemberRegistrationEventName,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.factory.getEventBus().publish({
        name,
        version: 1,
        data: { userId, ...payload } as never,
        metadata: {
          tenantId,
          userId,
          timestamp: new Date().toISOString(),
          traceId: randomUUID(),
          idempotencyKey: `${name}:${userId}:${randomUUID()}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        { err, tenantId, userId, event: name },
        'member-registration: no se pudo publicar el evento en el outbox',
      );
    }
  }
}
