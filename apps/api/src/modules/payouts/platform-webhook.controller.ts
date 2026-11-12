/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@didacta/database';
import {
  PayoutsWebhookLivemodeMismatchError,
  PayoutsWebhookSignatureInvalidError,
  accountIdOfEvent,
  isAccountEvent,
  minimalEventPayload,
  parsePlatformEvent,
  verifyStripeSignature,
  type PlatformStripeEvent,
} from '@didacta/mod-payouts';
import type { FastifyRequest } from 'fastify';
import { Logger as PinoLogger } from 'nestjs-pino';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import { PayoutsRuntime } from './payouts-runtime.service';

/** Resultado que se devuelve a Stripe (y que los tests leen). */
export interface PlatformWebhookResult {
  readonly received: true;
  /**
   * - `synced`       — evento de cuenta atribuido: se consultó la cuenta en Stripe.
   * - `duplicate`    — ya se había procesado (idempotencia por `stripe_event_id`).
   * - `unattributed` — el `acct_` no está en el registro: archivado sin efectos.
   * - `ignored`      — tipo que esta versión no atiende: archivado sin efectos.
   */
  readonly outcome: 'synced' | 'duplicate' | 'unattributed' | 'ignored';
}

/**
 * Webhook ÚNICO de la plataforma: `POST /api/v1/modules/payouts/webhook`.
 *
 * Público y sin resolver nada por `Host`. En E2 atiende solo eventos de
 * CUENTA (`account.updated`, `capability.updated`, `v2.core.account…`).
 *
 *  1. Firma contra `PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS` (todos del
 *     operador). Sin casar → 401. `livemode` distinto de la clave → 400.
 *  2. El tenant sale de `mod_payouts_object_ref` a partir del `acct_` (lo
 *     escribe nuestro servidor al crear la cuenta). Sin registro → se archiva
 *     «sin atribuir», 200, sin efectos. La metadata no decide nada.
 *  3. El evento solo DISPARA `syncAccount`, que lee la cuenta en Stripe. El
 *     estado nunca se fija con lo que trae el evento.
 *  4. Idempotencia por `stripe_event_id` (PK de `mod_payouts_webhook_event`).
 *     Si la consulta a Stripe falla, el evento queda sin `processed_at` y se
 *     responde 503 para que Stripe reintente; el reintento lo reprocesa.
 */
@ApiTags('Webhooks · Payouts')
@Controller('modules/payouts')
export class PlatformWebhookController {
  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly logger: PinoLogger,
  ) {}

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
    return this.process(event);
  }

  /** Separado de la verificación para que los tests lo ejerzan con eventos ya firmados. */
  async process(event: PlatformStripeEvent): Promise<PlatformWebhookResult> {
    const prisma = this.runtime.prisma;
    const existing = await runGlobalWithoutTenant(() =>
      prisma.modPayoutsWebhookEvent.findUnique({
        where: { stripeEventId: event.id },
        select: { processedAt: true, tenantId: true },
      }),
    );
    if (existing?.processedAt) return { received: true, outcome: 'duplicate' };

    const accountId = isAccountEvent(event.type) ? accountIdOfEvent(event) : null;
    if (!accountId) {
      await this.archive(event, null, 'ignorado: tipo sin manejador en esta versión (E2)');
      return { received: true, outcome: 'ignored' };
    }

    const tenantId = await this.runtime.tenantOfAccount(accountId);
    if (!tenantId) {
      this.logger.warn(
        { eventId: event.id, type: event.type, stripeAccountId: accountId },
        'payouts.unattributed: evento de una cuenta conectada que no está en el registro',
      );
      await this.archive(event, null, 'sin atribuir: acct_ sin registro');
      return { received: true, outcome: 'unattributed' };
    }

    return runAsTenant(
      tenantId,
      async () => {
        await prisma.modPayoutsWebhookEvent.createMany({
          data: [
            {
              stripeEventId: event.id,
              tenantId,
              type: event.type,
              objectId: accountId,
              livemode: event.livemode,
              payload: minimalEventPayload(event) as Prisma.InputJsonValue,
            },
          ],
          skipDuplicates: true,
        });
        try {
          await this.runtime.accounts.syncAccount(tenantId, accountId);
        } catch (err) {
          await prisma.modPayoutsWebhookEvent.update({
            where: { stripeEventId: event.id },
            data: {
              attempts: { increment: 1 },
              errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err),
            },
          });
          throw err;
        }
        await prisma.modPayoutsWebhookEvent.update({
          where: { stripeEventId: event.id },
          data: { processedAt: new Date(), errorMessage: null, attempts: { increment: 1 } },
        });
        return { received: true, outcome: 'synced' } as const;
      },
      { traceLabel: 'payouts-webhook' },
    );
  }

  /** Guarda el evento sin tenant y como procesado: no hay nada que hacer con él. */
  private async archive(
    event: PlatformStripeEvent,
    objectId: string | null,
    reason: string,
  ): Promise<void> {
    await runGlobalWithoutTenant(() =>
      this.runtime.prisma.modPayoutsWebhookEvent.createMany({
        data: [
          {
            stripeEventId: event.id,
            tenantId: null,
            type: event.type,
            objectId: objectId ?? accountIdOfEvent(event),
            livemode: event.livemode,
            payload: minimalEventPayload(event) as Prisma.InputJsonValue,
            processedAt: new Date(),
            errorMessage: reason,
            attempts: 1,
          },
        ],
        skipDuplicates: true,
      }),
    );
  }
}
