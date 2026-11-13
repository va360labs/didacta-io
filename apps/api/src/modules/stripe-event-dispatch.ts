/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  WebhookTenantMismatchError as BillingWebhookTenantMismatchError,
  type BillingService,
} from '@didacta/mod-billing';
import type { MembershipService, SubscriptionsService } from '@didacta/mod-subscriptions';
import type Stripe from 'stripe';
import type { ClientContext } from '../auth/client-context';
import { runAsTenant, runGlobalWithoutTenant } from '../tenancy/tenant-context.storage';

/**
 * Reparto de un evento de Stripe YA VERIFICADO y YA ATRIBUIDO a un tenant entre
 * los módulos que lo procesan (billing, suscripciones y membresía).
 *
 * Lo comparten los tres webhooks de Stripe:
 *  - `billing-webhook.controller.ts` (heredado, por aula) → solo billing;
 *  - `subscriptions-webhook.controller.ts` (heredado, por aula) → los tres;
 *  - `payouts/platform-webhook.controller.ts` (plataforma) → los tres.
 *
 * Cómo se decide el tenant NO está aquí: cada controlador lo decide a su manera
 * (dominio + secreto en los heredados, registro de objetos en el de plataforma)
 * y lo pasa ya decidido. Aquí solo se procesa, siempre bajo el contexto de ESE
 * tenant y diciéndole a cada módulo cuál es, para que compruebe cada fila que
 * toque (la segunda cerradura, `WebhookTenantMismatchError`).
 */

/** Los módulos que consumen eventos de Stripe. */
export interface StripeEventConsumers {
  readonly billing: BillingService;
  readonly subscriptions: SubscriptionsService;
  readonly membership: MembershipService;
}

/** Comprador anónimo → usuario del aula. Lo implementa el host por módulo. */
export type StripeBuyerProvisioner = (args: {
  tenantId: string;
  email: string;
  name: string | null;
  locale?: string;
  webBaseUrl: string;
  ctx: ClientContext;
}) => Promise<{ userId: string; created: boolean }>;

export interface StripeDispatchLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

interface DispatchBase {
  readonly event: Stripe.Event;
  /** Cuerpo del evento tal y como se archiva en las tablas de cada módulo. */
  readonly parsedBody: unknown;
  /** Tenant decidido por el controlador. Es el único con el que se escribe. */
  readonly tenantId: string;
  /** Dominio web del aula (para los enlaces de bienvenida). */
  readonly webBaseUrl: string;
  readonly ctx: ClientContext;
}

/**
 * Tenants que el evento nombra (metadata) o toca (dueños de las filas que el
 * procesado iría a buscar por id), según los módulos que lo van a procesar.
 * Solo lee; bajo acceso global sancionado.
 */
export async function collectStripeEventClaims(
  event: Stripe.Event,
  consumers: Pick<StripeEventConsumers, 'billing'> & Partial<StripeEventConsumers>,
): Promise<string[]> {
  return runGlobalWithoutTenant(async () => [
    ...(consumers.subscriptions
      ? await consumers.subscriptions.resolveWebhookTenantClaims(event)
      : []),
    ...(consumers.membership ? await consumers.membership.resolveWebhookTenantClaims(event) : []),
    ...(await consumers.billing.resolveWebhookTenantClaims(event)),
  ]);
}

/** Solo mod.billing: compra de curso suelto. Un fallo sale tal cual (Stripe reintenta). */
export async function dispatchStripeEventToBilling(
  args: DispatchBase & {
    readonly billing: BillingService;
    readonly provisionBuyer: StripeBuyerProvisioner;
  },
): Promise<void> {
  const { event, parsedBody, tenantId, webBaseUrl, ctx } = args;
  await runAsTenant(
    tenantId,
    () =>
      args.billing.handleWebhookEvent(event, parsedBody, {
        tenantId,
        provisionUser: ({ email, name, locale }) =>
          args.provisionBuyer({
            // El tenant decidido, no el que devuelva el módulo.
            tenantId,
            email,
            name,
            // Idioma con el que compró, capturado al iniciar el checkout y
            // transportado en la metadata de la session. El provisioner lo
            // valida y solo lo escribe si CREA la fila.
            locale,
            webBaseUrl,
            ctx,
          }),
      }),
    { traceLabel: 'billing-webhook' },
  );
}

/**
 * Los tres consumidores: suscripciones, membresía y, al final y como
 * best-effort, billing. Es lo que hacía el webhook heredado de suscripciones.
 */
export async function dispatchStripeEventToAll(
  args: DispatchBase & {
    readonly consumers: StripeEventConsumers;
    readonly provisionMember: StripeBuyerProvisioner;
    readonly provisionBuyer: StripeBuyerProvisioner;
    readonly logger: StripeDispatchLogger;
  },
): Promise<void> {
  const { event, parsedBody, tenantId, webBaseUrl, ctx, consumers, logger } = args;

  await runAsTenant(
    tenantId,
    () => consumers.subscriptions.handleWebhookEvent(event, parsedBody, { tenantId }),
    { traceLabel: 'subscriptions-webhook' },
  );

  // Fulfillment de MEMBRESÍA: el checkout completado materializa al
  // comprador (find-or-create user + bienvenida con enlace mágico) y crea la
  // suscripción local. Idempotente por stripeSubscriptionId — un retry de
  // Stripe no duplica user ni sub. Va DESPUÉS de handleWebhookEvent (que
  // persiste el evento para auditoría) y es independiente de su dedupe.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    // La membresía se crea en el tenant decidido. Antes salía de
    // `session.metadata.tenantId`, que escribe quien firma el evento: era el
    // agujero por el que un aula se regalaba membresías en otra.
    const fulfilled = await runAsTenant(
      tenantId,
      () =>
        consumers.membership.fulfillMembershipCheckout(
          session,
          ({ email, name, locale }) =>
            args.provisionMember({ tenantId, email, name, locale, webBaseUrl, ctx }),
          { tenantId },
        ),
      { traceLabel: 'membership-fulfillment' },
    );

    // Pagó teniendo ya una membresía viva. La venta anónima no permite
    // evitarlo antes —el correo lo escribe en la pantalla de Stripe—, así que
    // lo único que se puede hacer es que no pase inadvertido: son dos cobros
    // recurrentes por el mismo acceso, y nadie se queja de lo que no ve.
    // No se resuelve solo a propósito: reembolsar la nueva, cancelar la vieja
    // o dejar las dos es una decisión de negocio, no del webhook.
    if (fulfilled?.duplicateOf) {
      logger.warn(
        {
          tenantId,
          userId: fulfilled.userId,
          nueva: fulfilled.subscriptionId,
          existente: fulfilled.duplicateOf,
          stripeSession: session.id,
        },
        'MEMBRESÍA DUPLICADA: este usuario ya tenía una membresía viva y acaba de contratar otra. Hay que decidir cuál se queda.',
      );
    }
  }

  // FAN-OUT a mod.billing (compra de curso suelto). Una sola cuenta de Stripe
  // alimenta los dos módulos, así que un ÚNICO endpoint de webhook puede
  // servir a ambos: el evento ya viene verificado, y cada módulo procesa solo
  // lo suyo (la membresía descarta las sesiones sin `membership:'1'`; billing,
  // las que no llevan `orderId` + `productId`).
  // Best-effort: un fallo de billing NO puede tumbar el fulfillment de la
  // membresía ya hecho arriba, ni provocar que Stripe reintente el evento
  // durante días. Queda registrado en `mod_billing_webhook_event`.
  try {
    await dispatchStripeEventToBilling({
      event,
      parsedBody,
      tenantId,
      webBaseUrl,
      ctx,
      billing: consumers.billing,
      provisionBuyer: args.provisionBuyer,
    });
  } catch (err) {
    // Un evento que toca filas de otra aula NUNCA se traga, sea del tipo que
    // sea: es la segunda cerradura del módulo saltando.
    if (err instanceof BillingWebhookTenantMismatchError) throw err;
    // Si el evento ERA de una compra de curso, propagamos: Stripe verá un
    // 5xx y reintentará, que es la única red de seguridad que evita cobrar
    // sin dar acceso. Es seguro reintentar todo el handler porque el trabajo
    // de la membresía ya hecho arriba es idempotente (dedupe por evento y
    // por stripeSubscriptionId).
    // Si el evento NO era nuestro, lo tragamos: un fallo procesando algo
    // ajeno no puede hacer que Stripe reintente en bucle un evento de
    // membresía que sí se completó.
    if (isCoursePurchaseEvent(event)) {
      logger.error(
        { err, eventId: event.id, type: event.type },
        'stripe webhook: fallo procesando una COMPRA DE CURSO — devolvemos 5xx para que Stripe reintente',
      );
      throw err;
    }
    logger.warn(
      { err, eventId: event.id, type: event.type },
      'stripe webhook: mod.billing no pudo procesar un evento ajeno (no bloqueante)',
    );
  }
}

/**
 * ¿Este evento pertenece a una compra de curso de mod.billing? Se reconoce por
 * la marca que escribe su checkout (`orderId` + `productId` en la metadata).
 * Misma comprobación positiva que hace el propio servicio de billing.
 */
export function isCoursePurchaseEvent(event: Stripe.Event): boolean {
  const obj = event.data?.object as { metadata?: Record<string, string> } | undefined;
  const meta = obj?.metadata ?? {};
  return Boolean(meta['orderId'] && meta['productId']);
}
