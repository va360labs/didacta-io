/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Prisma } from '@didacta/database';
import {
  DISPUTE_EVENT_TYPES,
  REFUND_EVENT_TYPES,
  checkTransferEvent,
  handleChargeEvent,
  handleDisputeEvent,
  handleRefundEvent,
  minimalEventPayload,
  recordCheckoutSale,
  resolvePlatformEventTenant,
  routePlatformEvent,
  type CheckoutSaleOutcome,
  type ObjectRef,
  type PayoutsLogger,
  type PlatformEventRoute,
  type PlatformStripeEvent,
  type SettleOutcome,
} from '@didacta/mod-payouts';
import {
  PAYOUTS_RENEWAL_ON_BLOCKED_ACCOUNT_ALERT,
  SUBSCRIPTION_REF_SOURCES,
  accountHoldsRenewals,
  recordInvoiceSale,
  registerSubscriptionChildren,
  type InvoiceSaleOutcome,
} from '@didacta/mod-payouts';
import type { Logger as PinoLogger } from 'nestjs-pino';
import type Stripe from 'stripe';
import type { ClientContext } from '../../auth/client-context';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import type { PayoutsRuntime } from './payouts-runtime.service';
import type { PlatformEventDispatcher } from './platform-event-dispatcher';

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
  readonly sale?: CheckoutSaleOutcome['outcome'] | InvoiceSaleOutcome['outcome'] | 'pending';
  /**
   * Qué pasó con la liquidación cuando el evento la dispara (`charge.updated`,
   * o la compra cuando se liquida en línea): `transferred`, `awaiting_fee`,
   * `no_sale`… o `pending` si falló (la recoge el barrido).
   */
  readonly settlement?: SettleOutcome['outcome'] | 'no_sale' | 'pending';
  /** E6: qué pasó con un reembolso (`synced`, `no_sale`…) o `pending` si falló. */
  readonly refund?: string;
  /** E6: qué pasó con una disputa (`synced`, `no_sale`…) o `pending` si falló. */
  readonly dispute?: string;
}

/** Alerta que buscan los operadores en los logs. */
export const PAYOUTS_REF_MISMATCH_ALERT = 'payouts.ref_mismatch';

/** Tipos de evento con los que se anota la venta de una compra (E3). */
const SALE_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

/**
 * Procesa un evento de la cuenta de PLATAFORMA ya autenticado: lo que hace el
 * webhook único tras verificar la firma, y lo que hace el conciliador al
 * reproducir un evento sacado de `GET /v1/events` (que es auténtico porque lo
 * lee el servidor con la clave del operador).
 *
 *  1. Ids del evento según su tipo (`routePlatformEvent`). Eventos de cuenta:
 *     el `acct_` dispara `syncAccount`.
 *  2. Tenant SOLO desde nuestros registros (`mod_payouts_object_ref`), bajo
 *     acceso global sancionado: directo → padres → sesión de origen consultada
 *     a Stripe. La metadata no decide nada.
 *     - Nada registrado → archivado «sin atribuir», sin efectos.
 *     - Dos tenants, o el contenido del evento apunta a otro tenant u otra
 *       orden que el registro → archivado con error, alerta
 *       `payouts.ref_mismatch`, sin efectos.
 *  3. Bajo el contexto de ESE tenant: se guarda el evento (idempotente por
 *     `stripe_event_id`), la parte de DINERO y el REPARTO a los módulos.
 *     DINERO (E3/E4): la compra anota la venta `AWAITING_FEE` (y sin Redis la
 *     liquida en línea); `charge.updated` liquida; `transfer.*` solo coteja.
 *  4. Un fallo del reparto a módulos sale (5xx: Stripe reintenta; el evento
 *     queda sin `processed_at`). Un fallo de la parte de dinero NO bloquea el
 *     acceso: queda en `error_message` («dinero: …») y lo recoge el barrido o
 *     el conciliador.
 */
export class PlatformEventProcessor {
  private readonly moneyLogger: PayoutsLogger;

  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly logger: PinoLogger,
    private readonly dispatcher: PlatformEventDispatcher,
  ) {
    this.moneyLogger = {
      warn: (obj, msg) => logger.warn(obj, msg),
      log: (obj, msg) => logger.log(obj, msg),
      error: (obj, msg) => logger.error(obj, msg),
    };
  }

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

        // DINERO. No bloquea: si falla, el acceso se concede igual y lo
        // recogen el barrido de liquidación o el conciliador.
        const money = await this.money(
          event,
          route,
          tenantId,
          sessionRef,
          attribution.via === 'origin_session' ? (attribution.resolution.refs[0] ?? null) : null,
        );

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
          data: {
            // E6: un reembolso o una disputa de un cargo cuya venta aún no está
            // anotada se deja PENDIENTE: lo reproduce el conciliador (y la venta,
            // al anotarse, se pone al día ella misma).
            processedAt: money.pending ? null : new Date(),
            errorMessage: money.pending
              ? 'pendiente: la venta del cargo aún no está anotada'
              : money.error,
            attempts: { increment: 1 },
          },
        });
        return {
          received: true,
          outcome: 'processed',
          ...(money.sale ? { sale: money.sale } : {}),
          ...(money.settlement ? { settlement: money.settlement } : {}),
          ...(money.refund ? { refund: money.refund } : {}),
          ...(money.dispute ? { dispute: money.dispute } : {}),
        } as const;
      },
      { traceLabel: 'payouts-webhook' },
    );
  }

  /**
   * La parte de DINERO del evento. Nunca lanza: devuelve lo que pasó y, si
   * algo falló, el mensaje que se guarda en el evento («dinero: …»).
   */
  private async money(
    event: PlatformStripeEvent,
    route: Extract<PlatformEventRoute, { kind: 'objects' }>,
    tenantId: string,
    sessionRef: ObjectRef | null,
    /** Sesión de checkout de origen, cuando el evento se atribuyó preguntando a Stripe. */
    originRef: ObjectRef | null = null,
  ): Promise<{
    sale?: PlatformWebhookResult['sale'];
    settlement?: PlatformWebhookResult['settlement'];
    refund?: string;
    dispute?: string;
    /** E6: el evento se deja sin procesar para que se reintente. */
    pending?: boolean;
    error: string | null;
  }> {
    const fail = (stage: string, err: unknown, extra: Record<string, unknown>) => {
      this.logger.error(
        { err, eventId: event.id, tenantId, ...extra },
        `payouts.${stage}_pending: no se pudo completar (el acceso sigue su curso; lo recoge el conciliador)`,
      );
      return `dinero: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    };

    // E5 — membresías y suscripciones cobradas por la plataforma.
    const subscriptionSession = [sessionRef, originRef].find(
      (ref): ref is ObjectRef => !!ref && SUBSCRIPTION_REF_SOURCES.has(ref.source),
    );
    if (subscriptionSession || route.family === 'invoice') {
      const subscription = await this.subscriptionMoney(
        event,
        route,
        tenantId,
        subscriptionSession ?? null,
        fail,
      );
      // `null`: no era nada de la suscripción; el evento sigue su camino (un
      // `charge.*` atribuido por la sesión de origen se liquida como cualquiera).
      if (subscription) return subscription;
    }

    if (SALE_EVENT_TYPES.has(event.type) && sessionRef?.source === 'billing') {
      let recorded: CheckoutSaleOutcome;
      try {
        recorded = await this.recordSale(tenantId, sessionRef);
      } catch (err) {
        return {
          sale: 'pending',
          error: fail('sale', err, { sessionId: sessionRef.stripeObjectId }),
        };
      }
      // Sin Redis no hay barrido cada minuto: se liquida aquí mismo.
      if (
        this.runtime.settleInline &&
        (recorded.outcome === 'created' || recorded.outcome === 'exists')
      ) {
        try {
          const settled = await this.runtime.settlement.settleSale(tenantId, recorded.saleId, {
            force: true,
          });
          // E6: retenida por un reembolso o una disputa que aún no consta (sus
          // eventos llegaron antes que la venta): se ponen al día ahora.
          if (settled.outcome === 'held') await this.catchUpLosses(tenantId, recorded.chargeId);
          return { sale: recorded.outcome, settlement: settled.outcome, error: null };
        } catch (err) {
          return {
            sale: recorded.outcome,
            settlement: 'pending',
            error: fail('settlement', err, { saleId: recorded.saleId }),
          };
        }
      }
      return { sale: recorded.outcome, error: null };
    }

    // ── E6: reembolsos y disputas (antes que `charge`: `charge.refunded` es suyo).
    if (REFUND_EVENT_TYPES.has(event.type)) {
      try {
        const result = await handleRefundEvent(
          { refunds: this.runtime.refunds },
          {
            tenantId,
            eventType: event.type,
            object: (event.data?.object ?? {}) as Record<string, unknown>,
          },
        );
        return { refund: result.outcome, pending: result.outcome === 'no_sale', error: null };
      } catch (err) {
        return { refund: 'pending', error: fail('refund', err, { objectId: route.primaryId }) };
      }
    }
    if (DISPUTE_EVENT_TYPES.has(event.type)) {
      try {
        const result = await handleDisputeEvent(
          { disputes: this.runtime.disputes },
          {
            tenantId,
            eventType: event.type,
            object: (event.data?.object ?? {}) as Record<string, unknown>,
          },
        );
        return { dispute: result.outcome, pending: result.outcome === 'no_sale', error: null };
      } catch (err) {
        return { dispute: 'pending', error: fail('dispute', err, { disputeId: route.primaryId }) };
      }
    }
    // ── fin E6

    if (route.family === 'charge') {
      try {
        const result = await handleChargeEvent(
          { db: this.runtime.db, settlement: this.runtime.settlement },
          { tenantId, eventType: event.type, chargeId: route.primaryId },
        );
        if (result.outcome === 'ignored') return { error: null };
        return {
          settlement: result.outcome === 'settled' ? result.result.outcome : result.outcome,
          error: null,
        };
      } catch (err) {
        return {
          settlement: 'pending',
          error: fail('settlement', err, { chargeId: route.primaryId }),
        };
      }
    }

    if (route.family === 'transfer') {
      try {
        await checkTransferEvent(
          { db: this.runtime.db, stripe: this.runtime.stripe, logger: this.moneyLogger },
          { tenantId, eventType: event.type, transferId: route.primaryId },
        );
      } catch (err) {
        return { error: fail('transfer_check', err, { transferId: route.primaryId }) };
      }
    }
    return { error: null };
  }

  /**
   * DINERO de una suscripción (E5). Nunca lanza.
   *
   *  - El `completed` de su sesión, o el primer evento de la suscripción que se
   *    atribuyó por su sesión de origen (llegó antes que el `completed`): se
   *    atan `sub_…` y `cus_…` a la sesión, para que las renovaciones se
   *    atribuyan por el registro.
   *  - `invoice.paid` con importe → venta `SUBSCRIPTION_INVOICE` (y sin Redis,
   *    liquidada en línea). La factura de 0 € de una prueba gratis no anota
   *    nada. `invoice.payment_failed` no mueve dinero.
   *  - Renovación cobrada con la cuenta del creador restringida → la venta se
   *    anota y la liquidación la retiene; alerta para el operador.
   *
   * Devuelve `null` si al evento no le queda nada de la suscripción: Stripe
   * también encuentra la sesión de una suscripción por el PaymentIntent de su
   * primera factura, así que un `charge.*` puede llegar aquí por la sesión de
   * origen y tiene que seguir a la liquidación del cargo.
   */
  private async subscriptionMoney(
    event: PlatformStripeEvent,
    route: Extract<PlatformEventRoute, { kind: 'objects' }>,
    tenantId: string,
    sessionRef: ObjectRef | null,
    fail: (stage: string, err: unknown, extra: Record<string, unknown>) => string,
  ): Promise<{
    sale?: PlatformWebhookResult['sale'];
    settlement?: PlatformWebhookResult['settlement'];
    error: string | null;
  } | null> {
    const deps = { db: this.runtime.db, stripe: this.runtime.stripe };
    if (
      sessionRef &&
      (event.type === 'checkout.session.completed' || route.family !== 'checkout_session')
    ) {
      try {
        await registerSubscriptionChildren(deps, { tenantId, sessionRef });
      } catch (err) {
        return { error: fail('subscription_refs', err, { sessionId: sessionRef.stripeObjectId }) };
      }
    }
    if (route.family !== 'invoice') return null;
    if (event.type !== 'invoice.paid' || !route.primaryId) return { error: null };

    let recorded: InvoiceSaleOutcome;
    try {
      recorded = await recordInvoiceSale(deps, { tenantId, invoiceId: route.primaryId });
    } catch (err) {
      return { sale: 'pending', error: fail('sale', err, { invoiceId: route.primaryId }) };
    }
    if (recorded.outcome !== 'created' && recorded.outcome !== 'exists') {
      return { sale: recorded.outcome, error: null };
    }
    if (accountHoldsRenewals(recorded.accountStatus)) {
      this.logger.error(
        {
          alert: PAYOUTS_RENEWAL_ON_BLOCKED_ACCOUNT_ALERT,
          eventId: event.id,
          tenantId,
          saleId: recorded.saleId,
          accountStatus: recorded.accountStatus,
        },
        `${PAYOUTS_RENEWAL_ON_BLOCKED_ACCOUNT_ALERT}: renovación cobrada con la cuenta del creador ${recorded.accountStatus}; la venta queda retenida hasta que pueda recibir transferencias`,
      );
    }
    if (!this.runtime.settleInline) return { sale: recorded.outcome, error: null };
    try {
      const settled = await this.runtime.settlement.settleSale(tenantId, recorded.saleId, {
        force: true,
      });
      // E6, igual que en la venta de una compra: un reembolso o una disputa de
      // este cargo que llegó antes que la factura se pone al día ahora.
      if (settled.outcome === 'held') await this.catchUpLosses(tenantId, recorded.chargeId);
      return { sale: recorded.outcome, settlement: settled.outcome, error: null };
    } catch (err) {
      return {
        sale: recorded.outcome,
        settlement: 'pending',
        error: fail('settlement', err, { saleId: recorded.saleId }),
      };
    }
  }

  /**
   * E6: disputas y reembolsos de un cargo recién anotado cuyos eventos llegaron
   * antes que la venta. Nunca lanza: si falla, lo recoge el conciliador.
   */
  private async catchUpLosses(tenantId: string, chargeId: string): Promise<void> {
    try {
      await this.runtime.disputes.syncCharge(tenantId, chargeId);
      await this.runtime.refunds.syncCharge(tenantId, chargeId);
    } catch (err) {
      this.logger.warn(
        { err, tenantId, chargeId },
        'payouts: no se pudieron poner al día las disputas o reembolsos del cargo (lo recoge el conciliador)',
      );
    }
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
