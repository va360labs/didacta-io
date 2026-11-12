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
import type { Prisma } from '@didacta/database';
import {
  PayoutsWebhookLivemodeMismatchError,
  PayoutsWebhookSignatureInvalidError,
  minimalEventPayload,
  parsePlatformEvent,
  recordCheckoutSale,
  resolvePlatformEventTenant,
  routePlatformEvent,
  verifyStripeSignature,
  type CheckoutSaleOutcome,
  type ObjectRef,
  type PlatformEventRoute,
  type PlatformStripeEvent,
} from '@didacta/mod-payouts';
import type { FastifyRequest } from 'fastify';
import { Logger as PinoLogger } from 'nestjs-pino';
import type Stripe from 'stripe';
import { extractClientContext, type ClientContext } from '../../auth/client-context';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import { PayoutsRuntime } from './payouts-runtime.service';
import {
  PLATFORM_EVENT_DISPATCHER,
  type PlatformEventDispatcher,
} from './platform-event-dispatcher';

/** Resultado que se devuelve a Stripe (y que los tests leen). */
export interface PlatformWebhookResult {
  readonly received: true;
  /**
   * - `synced`       — evento de cuenta atribuido: se consultó la cuenta en Stripe.
   * - `processed`    — evento de un cobro atribuido: repartido a los módulos.
   * - `duplicate`    — ya se había procesado (idempotencia por `stripe_event_id`).
   * - `unattributed` — nada de lo que nombra está en el registro: archivado sin efectos.
   * - `mismatch`     — el registro y el contenido del evento no casan: archivado
   *                    con error, alerta `payouts.ref_mismatch`, sin efectos.
   * - `ignored`      — tipo que esta versión no atiende: archivado sin efectos.
   */
  readonly outcome: 'synced' | 'processed' | 'duplicate' | 'unattributed' | 'mismatch' | 'ignored';
  /** Solo en compras: qué pasó con la venta (`created`, `exists`, `not_paid`…, o `pending`). */
  readonly sale?: CheckoutSaleOutcome['outcome'] | 'pending';
}

/** Alerta que buscan los operadores en los logs. */
export const PAYOUTS_REF_MISMATCH_ALERT = 'payouts.ref_mismatch';

/** Tipos de evento con los que se anota la venta de una compra (E3). */
const SALE_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

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
 *     `stripe_event_id`), la parte de DINERO —registrar `pi_`/`ch_`/`cus_` y
 *     anotar la venta `AWAITING_FEE` con importes leídos de la API— y el
 *     REPARTO a los módulos con las mismas funciones que los webhooks
 *     heredados (billing concede el acceso como siempre).
 *  5. Un fallo del reparto a módulos → 5xx (Stripe reintenta; el evento queda
 *     sin `processed_at`). Un fallo de la parte de dinero NO bloquea el acceso:
 *     queda apuntado en el evento (`error_message` «dinero: …») y lo recoge el
 *     conciliador (E4).
 */
@ApiTags('Webhooks · Payouts')
@Controller('modules/payouts')
export class PlatformWebhookController {
  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly logger: PinoLogger,
    @Inject(PLATFORM_EVENT_DISPATCHER) private readonly dispatcher: PlatformEventDispatcher,
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
    return this.process(event, extractClientContext(req));
  }

  /** Separado de la verificación para que los tests lo ejerzan con eventos ya firmados. */
  async process(
    event: PlatformStripeEvent,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<PlatformWebhookResult> {
    const prisma = this.runtime.prisma;
    const existing = await runGlobalWithoutTenant(() =>
      prisma.modPayoutsWebhookEvent.findUnique({
        where: { stripeEventId: event.id },
        select: { processedAt: true, tenantId: true },
      }),
    );
    if (existing?.processedAt) return { received: true, outcome: 'duplicate' };

    const route = routePlatformEvent(event);
    if (route.kind === 'account') return this.processAccountEvent(event, route.accountId);
    if (route.kind === 'unknown') {
      await this.archive(event, null, 'ignorado: tipo sin manejador en esta versión');
      return { received: true, outcome: 'ignored' };
    }

    const attribution = await runGlobalWithoutTenant(() =>
      resolvePlatformEventTenant(route, { refs: this.runtime.refs, stripe: this.runtime.stripe }),
    );
    if (attribution.status === 'unknown') {
      this.logger.warn(
        { eventId: event.id, type: event.type, objectIds: route.objectIds },
        'payouts.unattributed: evento de plataforma sin ningún objeto registrado',
      );
      await this.archive(event, route.primaryId, 'sin atribuir: ningún id en el registro');
      return { received: true, outcome: 'unattributed' };
    }
    if (attribution.status === 'ambiguous') {
      return this.rejectMismatch(event, route, 'los ids del evento son de varios tenants', {
        tenantIds: attribution.tenantIds,
      });
    }

    const tenantId = attribution.tenantId;
    const sessionRef =
      route.family === 'checkout_session' && route.primaryId
        ? (attribution.resolution.refs.find((ref) => ref.stripeObjectId === route.primaryId) ??
          null)
        : null;
    const mismatch = await this.findMismatch(event, tenantId, sessionRef);
    if (mismatch) {
      return this.rejectMismatch(event, route, mismatch.reason, {
        registryTenantId: tenantId,
        ...mismatch.detail,
      });
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
              objectId: route.primaryId,
              livemode: event.livemode,
              payload: minimalEventPayload(event) as Prisma.InputJsonValue,
            },
          ],
          skipDuplicates: true,
        });

        // DINERO. No bloquea: si falla, el acceso se concede igual y la venta
        // la recoge el conciliador.
        let sale: PlatformWebhookResult['sale'];
        let moneyError: string | null = null;
        if (SALE_EVENT_TYPES.has(event.type) && sessionRef?.source === 'billing') {
          try {
            sale = (await this.recordSale(tenantId, sessionRef)).outcome;
          } catch (err) {
            sale = 'pending';
            moneyError = `dinero: ${err instanceof Error ? err.message : String(err)}`.slice(
              0,
              500,
            );
            this.logger.error(
              { err, eventId: event.id, tenantId, sessionId: sessionRef.stripeObjectId },
              'payouts.sale_pending: no se pudo anotar la venta (el acceso sigue su curso; la recoge el conciliador)',
            );
          }
        }

        // REPARTO a los módulos: acceso al curso, membresía… Un fallo → 5xx.
        try {
          await this.dispatcher.dispatch({
            event: event as unknown as Stripe.Event,
            parsedBody: event,
            tenantId,
            ctx,
            logger: this.logger,
          });
        } catch (err) {
          await prisma.modPayoutsWebhookEvent.update({
            where: { stripeEventId: event.id },
            data: {
              attempts: { increment: 1 },
              errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
            },
          });
          throw err;
        }

        await prisma.modPayoutsWebhookEvent.update({
          where: { stripeEventId: event.id },
          data: { processedAt: new Date(), errorMessage: moneyError, attempts: { increment: 1 } },
        });
        return { received: true, outcome: 'processed', ...(sale ? { sale } : {}) } as const;
      },
      { traceLabel: 'payouts-webhook' },
    );
  }

  /** Eventos de cuenta (E2): el evento solo dispara `syncAccount`. */
  private async processAccountEvent(
    event: PlatformStripeEvent,
    accountId: string,
  ): Promise<PlatformWebhookResult> {
    const prisma = this.runtime.prisma;
    const tenantId = await this.runtime.tenantOfAccount(accountId);
    if (!tenantId) {
      this.logger.warn(
        { eventId: event.id, type: event.type, stripeAccountId: accountId },
        'payouts.unattributed: evento de una cuenta conectada que no está en el registro',
      );
      await this.archive(event, accountId, 'sin atribuir: acct_ sin registro');
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

  /**
   * ¿Contradice el contenido del evento al registro? El registro dice de qué
   * tenant es; si la metadata o las filas que el evento nombra son de OTRO
   * tenant, o la sesión apunta a otra orden que la registrada, algo va mal (un
   * objeto creado en la cuenta del operador con datos ajenos, o un fallo
   * nuestro). No se elige: no se procesa.
   */
  private async findMismatch(
    event: PlatformStripeEvent,
    tenantId: string,
    sessionRef: ObjectRef | null,
  ): Promise<{ reason: string; detail: Record<string, unknown> } | null> {
    const claims = await this.dispatcher.claims(event as unknown as Stripe.Event);
    const foreign = [...new Set(claims.filter((claim) => claim && claim !== tenantId))];
    if (foreign.length > 0) {
      return {
        reason: 'el evento nombra a otro tenant que el registro',
        detail: { claimedTenantIds: foreign.slice(0, 5).map((t) => t.slice(0, 64)) },
      };
    }
    if (sessionRef?.localRef) {
      const object = (event.data?.object ?? {}) as {
        metadata?: Record<string, unknown> | null;
        client_reference_id?: unknown;
      };
      const named = [object.metadata?.['orderId'], object.client_reference_id].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      if (named.some((orderId) => orderId !== sessionRef.localRef)) {
        return {
          reason: 'la sesión apunta a otra orden que la registrada',
          detail: { registryOrderId: sessionRef.localRef },
        };
      }
    }
    return null;
  }

  private async rejectMismatch(
    event: PlatformStripeEvent,
    route: Extract<PlatformEventRoute, { kind: 'objects' }>,
    reason: string,
    detail: Record<string, unknown>,
  ): Promise<PlatformWebhookResult> {
    this.logger.error(
      {
        alert: PAYOUTS_REF_MISMATCH_ALERT,
        eventId: event.id,
        type: event.type,
        objectIds: route.objectIds,
        ...detail,
      },
      `${PAYOUTS_REF_MISMATCH_ALERT}: ${reason}. Evento archivado sin efectos.`,
    );
    await this.archive(event, route.primaryId, `${PAYOUTS_REF_MISMATCH_ALERT}: ${reason}`);
    return { received: true, outcome: 'mismatch' };
  }

  private recordSale(tenantId: string, sessionRef: ObjectRef): Promise<CheckoutSaleOutcome> {
    if (!sessionRef.localRef) {
      throw new Error(`la sesión ${sessionRef.stripeObjectId} no tiene orden registrada`);
    }
    return recordCheckoutSale(
      { db: this.runtime.db, stripe: this.runtime.stripe },
      { tenantId, sessionId: sessionRef.stripeObjectId, orderId: sessionRef.localRef },
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
            objectId,
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
