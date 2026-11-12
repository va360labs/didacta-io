/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { accountIdOfEvent, isAccountEvent, type PlatformStripeEvent } from './account-events.js';
import type { RefsService, TenantResolution } from './refs.service.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Enrutado de los eventos del webhook ÚNICO de plataforma (etapa E3).
 *
 * En modo plataforma todas las academias cobran en la cuenta del operador: la
 * firma del evento solo dice que lo manda Stripe, no de qué academia es. Este
 * fichero responde a dos preguntas, y a ninguna más:
 *
 *  1. ¿Qué ids de Stripe nombra el evento? (`routePlatformEvent`) — según el
 *     tipo, el objeto y sus padres: la sesión, el PaymentIntent, el cliente,
 *     la suscripción…
 *  2. ¿De qué tenant es? (`resolvePlatformEventTenant`) — SOLO a partir de
 *     `mod_payouts_object_ref`, que escribe nuestro servidor al crear cada
 *     objeto. En orden: registro directo de los ids → registro de sus padres →
 *     consulta a Stripe de la sesión de checkout de origen y registro de ESA
 *     sesión. La metadata del evento no interviene: la puede escribir
 *     cualquiera que cree objetos en la cuenta.
 *
 * Qué se hace con el evento lo decide el host (`platform-webhook.controller.ts`)
 * y los manejadores de `handlers/`.
 */

/** Familia de objetos a la que pertenece un evento (tabla del plan, §3). */
export type PlatformEventFamily =
  | 'checkout_session'
  | 'subscription'
  | 'invoice'
  | 'charge'
  | 'refund'
  | 'dispute'
  | 'transfer'
  | 'payout';

export type PlatformEventRoute =
  /** Evento de cuenta conectada: el tenant sale del `acct_`. */
  | { readonly kind: 'account'; readonly accountId: string }
  | {
      readonly kind: 'objects';
      readonly family: PlatformEventFamily;
      /** Id del objeto principal del evento (`cs_…`, `ch_…`…). */
      readonly primaryId: string | null;
      /** Todos los ids que nombra, sin repetidos, empezando por el principal. */
      readonly objectIds: readonly string[];
      /** PaymentIntent nombrado, para buscar la sesión de origen en Stripe. */
      readonly paymentIntentId: string | null;
      /** Suscripción nombrada, ídem. */
      readonly subscriptionId: string | null;
    }
  /** Tipo que esta versión no sabe atribuir. */
  | { readonly kind: 'unknown' };

/** Tipos de evento por familia. Lo que no esté aquí es `unknown`. */
const FAMILY_OF_TYPE: ReadonlyArray<readonly [RegExp, PlatformEventFamily]> = [
  [
    /^checkout\.session\.(completed|async_payment_succeeded|async_payment_failed|expired)$/,
    'checkout_session',
  ],
  [/^customer\.subscription\.(created|updated|deleted)$/, 'subscription'],
  [/^invoice\.(paid|payment_failed)$/, 'invoice'],
  [/^charge\.(succeeded|updated|refunded)$/, 'charge'],
  [/^refund\.(created|updated|failed)$/, 'refund'],
  [/^charge\.dispute\.(created|funds_withdrawn|funds_reinstated|closed)$/, 'dispute'],
  [/^transfer\.(created|reversed|updated)$/, 'transfer'],
  [/^payout\.failed$/, 'payout'],
];

const STRIPE_ID = /^[a-z][a-z0-9]*_[A-Za-z0-9_]{1,250}$/;

/** El id de un campo que puede venir como cadena o como objeto expandido. */
export function idOf(value: unknown): string | null {
  if (typeof value === 'string') return STRIPE_ID.test(value) ? value : null;
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' && STRIPE_ID.test(id) ? id : null;
  }
  return null;
}

/**
 * Suscripción de una factura, en las tres formas que ha tenido según la
 * versión de la API: `invoice.subscription`, `invoice.parent.subscription_details.subscription`
 * y `invoice.lines.data[].parent.subscription_item_details.subscription`.
 */
export function subscriptionIdFromInvoice(invoice: Record<string, unknown>): string | null {
  const direct = idOf(invoice['subscription']);
  if (direct) return direct;
  const parent = invoice['parent'] as
    | { subscription_details?: { subscription?: unknown } }
    | undefined;
  const fromParent = idOf(parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;
  const lines = (invoice['lines'] as { data?: unknown[] } | undefined)?.data ?? [];
  for (const line of lines) {
    const item = (line as { parent?: { subscription_item_details?: { subscription?: unknown } } })
      ?.parent?.subscription_item_details?.subscription;
    const id = idOf(item);
    if (id) return id;
  }
  return null;
}

function familyOf(type: string): PlatformEventFamily | null {
  for (const [pattern, family] of FAMILY_OF_TYPE) if (pattern.test(type)) return family;
  return null;
}

/** ¿Qué nombra este evento? Pura: no consulta nada. */
export function routePlatformEvent(event: PlatformStripeEvent): PlatformEventRoute {
  if (isAccountEvent(event.type)) {
    const accountId = accountIdOfEvent(event);
    return accountId ? { kind: 'account', accountId } : { kind: 'unknown' };
  }
  const family = familyOf(event.type);
  if (!family) return { kind: 'unknown' };
  const object = (event.data?.object ?? {}) as Record<string, unknown>;

  let primaryId: string | null = idOf(object['id']);
  let paymentIntentId: string | null = null;
  let subscriptionId: string | null = null;
  const others: Array<string | null> = [];

  switch (family) {
    case 'checkout_session':
      paymentIntentId = idOf(object['payment_intent']);
      subscriptionId = idOf(object['subscription']);
      others.push(paymentIntentId, subscriptionId, idOf(object['customer']));
      break;
    case 'subscription':
      subscriptionId = primaryId;
      others.push(idOf(object['customer']));
      break;
    case 'invoice':
      subscriptionId = subscriptionIdFromInvoice(object);
      paymentIntentId = idOf(object['payment_intent']);
      others.push(subscriptionId, paymentIntentId, idOf(object['customer']));
      break;
    case 'charge':
      paymentIntentId = idOf(object['payment_intent']);
      others.push(paymentIntentId, idOf(object['customer']));
      break;
    case 'refund':
    case 'dispute':
      paymentIntentId = idOf(object['payment_intent']);
      others.push(idOf(object['charge']), paymentIntentId);
      break;
    case 'transfer':
      others.push(idOf(object['source_transaction']), idOf(object['destination']));
      break;
    case 'payout':
      // Connect: el pago al banco es de la cuenta conectada que lo emite.
      primaryId = idOf(event.account) ?? null;
      break;
  }

  const objectIds = [...new Set([primaryId, ...others].filter((id): id is string => !!id))];
  return { kind: 'objects', family, primaryId, objectIds, paymentIntentId, subscriptionId };
}

/**
 * Todos los ids que nombra un evento de CUALQUIER tipo, con la forma de un
 * objeto de Stripe. Lo usan los webhooks heredados (claves propias) para
 * rechazar un evento que nombre un objeto de plataforma, aunque sea de un tipo
 * que el webhook de plataforma no atiende.
 */
export function stripeIdsNamedByEvent(event: {
  readonly type: string;
  readonly account?: string | null;
  readonly data?: { readonly object?: unknown } | null;
}): string[] {
  const route = routePlatformEvent(event as PlatformStripeEvent);
  const ids = new Set<string>(route.kind === 'objects' ? route.objectIds : []);
  if (route.kind === 'account') ids.add(route.accountId);
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  for (const key of [
    'id',
    'payment_intent',
    'customer',
    'subscription',
    'charge',
    'invoice',
    'latest_charge',
    'on_behalf_of',
  ]) {
    const id = idOf(object[key]);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Resultado de atribuir un evento a un tenant. */
export type PlatformEventAttribution =
  | {
      readonly status: 'resolved';
      readonly tenantId: string;
      /** Cómo se llegó: por los propios ids, por sus padres o preguntando a Stripe. */
      readonly via: 'direct' | 'parent' | 'origin_session';
      readonly resolution: Extract<TenantResolution, { status: 'resolved' }>;
    }
  | { readonly status: 'unknown' }
  | { readonly status: 'ambiguous'; readonly tenantIds: readonly string[] };

/**
 * ¿De qué tenant es el evento? Llamar bajo acceso global sancionado (el
 * registro se busca entre todos los tenants).
 *
 * La consulta a Stripe solo se hace cuando el evento nombra un PaymentIntent o
 * una suscripción y nada de lo nombrado está registrado: es el caso de un
 * evento que llega antes de que el webhook del checkout haya registrado los
 * hijos de la sesión.
 */
export async function resolvePlatformEventTenant(
  route: Extract<PlatformEventRoute, { kind: 'objects' }>,
  deps: {
    readonly refs: Pick<RefsService, 'resolveTenant' | 'resolveTenantByParents'>;
    readonly stripe: PlatformStripeClient;
  },
): Promise<PlatformEventAttribution> {
  const direct = await deps.refs.resolveTenant(route.objectIds);
  if (direct.status === 'resolved') {
    return { status: 'resolved', tenantId: direct.tenantId, via: 'direct', resolution: direct };
  }
  if (direct.status === 'ambiguous') return { status: 'ambiguous', tenantIds: direct.tenantIds };

  // Padres: un id del evento que no está registrado él mismo pero figura como
  // `parent_object_id` de algo que sí — p. ej. un `pi_` cuyo cargo ya se
  // registró desde otro evento.
  const viaParent = await deps.refs.resolveTenantByParents(route.objectIds);
  if (viaParent.status === 'resolved') {
    return {
      status: 'resolved',
      tenantId: viaParent.tenantId,
      via: 'parent',
      resolution: viaParent,
    };
  }
  if (viaParent.status === 'ambiguous') {
    return { status: 'ambiguous', tenantIds: viaParent.tenantIds };
  }

  const origin = await findOriginSessionId(route, deps.stripe);
  if (!origin) return { status: 'unknown' };
  const viaOrigin = await deps.refs.resolveTenant([origin]);
  if (viaOrigin.status === 'resolved') {
    return {
      status: 'resolved',
      tenantId: viaOrigin.tenantId,
      via: 'origin_session',
      resolution: viaOrigin,
    };
  }
  return viaOrigin.status === 'ambiguous'
    ? { status: 'ambiguous', tenantIds: viaOrigin.tenantIds }
    : { status: 'unknown' };
}

/** `GET /v1/checkout/sessions?payment_intent=…` (o `?subscription=…`). */
async function findOriginSessionId(
  route: Extract<PlatformEventRoute, { kind: 'objects' }>,
  stripe: PlatformStripeClient,
): Promise<string | null> {
  if (route.family === 'checkout_session') return null; // la sesión ES el evento
  const query = route.paymentIntentId
    ? { payment_intent: route.paymentIntentId }
    : route.subscriptionId
      ? { subscription: route.subscriptionId }
      : null;
  if (!query) return null;
  const list = await stripe.v1<{ data?: Array<{ id?: unknown }> }>('GET', '/v1/checkout/sessions', {
    ...query,
    limit: 1,
  });
  return idOf(list.data?.[0]?.id);
}
