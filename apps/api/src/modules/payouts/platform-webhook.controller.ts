/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PayoutsWebhookLivemodeMismatchError,
  PayoutsWebhookSignatureInvalidError,
  parsePlatformEvent,
  verifyStripeSignature,
  type PlatformStripeEvent,
} from '@didacta/mod-payouts';
import type { FastifyRequest } from 'fastify';
import { Logger as PinoLogger } from 'nestjs-pino';
import { extractClientContext, type ClientContext } from '../../auth/client-context';
import { PayoutsRuntime } from './payouts-runtime.service';
import {
  PLATFORM_EVENT_DISPATCHER,
  type PlatformEventDispatcher,
} from './platform-event-dispatcher';
import { PlatformEventProcessor, type PlatformWebhookResult } from './platform-event-processor';

export { PAYOUTS_REF_MISMATCH_ALERT, type PlatformWebhookResult } from './platform-event-processor';

/**
 * Webhook ÚNICO de la plataforma: `POST /api/v1/modules/payouts/webhook`.
 *
 * Público y sin resolver nada por `Host`. Lo firma Stripe con los secretos del
 * OPERADOR (`PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS`); ningún aula los
 * conoce.
 *
 *  1. Firma → 401 si no casa con ningún secreto. `livemode` distinto del de la
 *     clave → 400 (endpoint mal cableado).
 *  2. Ids del evento según su tipo (`routePlatformEvent`). Eventos de cuenta:
 *     como en E2, el `acct_` dispara `syncAccount`.
 *  3. Tenant SOLO desde nuestros registros (`mod_payouts_object_ref`), bajo
 *     acceso global sancionado: directo → padres → sesión de origen consultada
 *     a Stripe. La metadata no decide nada.
 *     - Nada registrado → archivado «sin atribuir», 200, sin efectos.
 *     - Dos tenants, o el contenido del evento (metadata, la orden que nombra)
 *       apunta a otro tenant u otra orden que el registro → archivado con
 *       error, alerta `payouts.ref_mismatch`, 200, sin efectos.
 *  4. Bajo el contexto de ESE tenant: se guarda el evento (idempotente por
 *     `stripe_event_id`), la parte de DINERO —anotar la venta de la compra,
 *     liquidar con `charge.updated`, cotejar `transfer.*`— y el REPARTO a los
 *     módulos con las mismas funciones que los webhooks heredados (billing
 *     concede el acceso como siempre).
 *  5. Un fallo del reparto a módulos → 5xx (Stripe reintenta; el evento queda
 *     sin `processed_at`). Un fallo de la parte de dinero NO bloquea el acceso:
 *     queda apuntado en el evento (`error_message` «dinero: …») y lo recogen
 *     el barrido de liquidación y el conciliador.
 *
 * Los pasos 2–5 viven en `PlatformEventProcessor`: el conciliador los usa
 * tal cual para reproducir los eventos que Stripe no llegó a entregar.
 */
@ApiTags('Webhooks · Payouts')
@Controller('modules/payouts')
export class PlatformWebhookController {
  private readonly processor: PlatformEventProcessor;

  constructor(
    private readonly runtime: PayoutsRuntime,
    logger: PinoLogger,
    @Inject(PLATFORM_EVENT_DISPATCHER) dispatcher: PlatformEventDispatcher,
  ) {
    this.processor = new PlatformEventProcessor(runtime, logger, dispatcher);
  }

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Webhook de Stripe de la plataforma. Firma con el secreto del operador; tenant desde el registro de objetos.',
  })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>): Promise<PlatformWebhookResult> {
    const raw = req.rawBody;
    if (!raw || raw.length === 0) {
      throw new BadRequestException({
        message: 'Cuerpo vacío: Stripe siempre manda el evento.',
        code: 'PAYOUTS_WEBHOOK_EMPTY_BODY',
      });
    }
    const header = req.headers['stripe-signature'];
    const verification = verifyStripeSignature({
      payload: raw,
      header: Array.isArray(header) ? header[0] : header,
      secrets: this.runtime.config.webhookSecrets,
    });
    if (!verification.valid) throw new PayoutsWebhookSignatureInvalidError(verification.reason);

    const event = parsePlatformEvent(raw.toString('utf8'));
    if (event.livemode !== this.runtime.config.livemode) {
      throw new PayoutsWebhookLivemodeMismatchError(event.livemode);
    }
    return this.process(event, extractClientContext(req));
  }

  /** Separado de la verificación para que los tests lo ejerzan con eventos ya firmados. */
  process(
    event: PlatformStripeEvent,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<PlatformWebhookResult> {
    return this.processor.process(event, ctx);
  }
}
