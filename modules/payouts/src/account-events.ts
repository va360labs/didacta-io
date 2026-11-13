/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PayoutsWebhookPayloadInvalidError } from './errors.js';

/**
 * Eventos de CUENTA del webhook de plataforma (etapa E2). E3 añade el resto
 * (`event-router.ts`); aquí solo se sabe qué `acct_` nombra un evento.
 *
 * Un evento de cuenta NUNCA fija el estado: dice «esta cuenta ha cambiado» y
 * el host dispara `syncAccount`, que pregunta a Stripe. Por eso de cada
 * evento solo interesa el id de la cuenta, y lo que se guarda en
 * `mod_payouts_webhook_event` es lo mínimo (sin `data.object`, que trae
 * nombres, correos y direcciones del creador).
 */

/** Lo que llega por el webhook, ya con la firma verificada. */
export interface PlatformStripeEvent {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly created?: number | string;
  /** v1 Connect: la cuenta conectada a la que pertenece el evento. */
  readonly account?: string | null;
  /** v2: cuenta en cuyo contexto ocurrió. */
  readonly context?: string | null;
  /** v2 («thin events»): el objeto al que se refiere. */
  readonly related_object?: {
    readonly id?: string;
    readonly type?: string;
    readonly url?: string;
  } | null;
  readonly data?: { readonly object?: Record<string, unknown> } | null;
}

const V1_ACCOUNT_EVENTS = new Set(['account.updated', 'capability.updated']);
const ACCT = /^acct_[A-Za-z0-9]{6,64}$/;

/** ¿Es un evento de cuenta que E2 sabe atender? */
export function isAccountEvent(type: string): boolean {
  return V1_ACCOUNT_EVENTS.has(type) || type.startsWith('v2.core.account');
}

function acct(value: unknown): string | null {
  return typeof value === 'string' && ACCT.test(value) ? value : null;
}

/**
 * `acct_` que nombra un evento de cuenta, o `null` si no nombra ninguno.
 *
 *  - `account.updated` → `event.account` (o `data.object.id`).
 *  - `capability.updated` → `event.account` (o `data.object.account`).
 *  - `v2.core.account…` → `related_object.id` si es la cuenta; si el objeto
 *    es otro (una persona de la cuenta), el `context`.
 */
export function accountIdOfEvent(event: PlatformStripeEvent): string | null {
  if (event.type === 'account.updated') {
    return acct(event.account) ?? acct(event.data?.object?.['id']);
  }
  if (event.type === 'capability.updated') {
    return acct(event.account) ?? acct(event.data?.object?.['account']);
  }
  if (event.type.startsWith('v2.core.account')) {
    return acct(event.related_object?.id) ?? acct(event.context);
  }
  return null;
}

/**
 * Valida la forma mínima de un evento ya firmado. La firma dice QUIÉN lo
 * manda (Stripe con el secreto del operador); esto solo evita trabajar con
 * algo que no es un evento.
 */
export function parsePlatformEvent(raw: string): PlatformStripeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PayoutsWebhookPayloadInvalidError('el cuerpo no es JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new PayoutsWebhookPayloadInvalidError('el cuerpo no es un objeto');
  }
  const event = parsed as Record<string, unknown>;
  if (typeof event['id'] !== 'string' || !/^evt_[A-Za-z0-9_]{1,250}$/.test(event['id'])) {
    throw new PayoutsWebhookPayloadInvalidError('falta un id evt_ válido');
  }
  if (typeof event['type'] !== 'string' || event['type'].length === 0) {
    throw new PayoutsWebhookPayloadInvalidError('falta el tipo');
  }
  if (typeof event['livemode'] !== 'boolean') {
    throw new PayoutsWebhookPayloadInvalidError('falta livemode');
  }
  return event as unknown as PlatformStripeEvent;
}

/** Lo que se archiva de un evento: identidad y a qué apunta, sin `data.object`. */
export function minimalEventPayload(event: PlatformStripeEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    created: event.created ?? null,
    account: event.account ?? null,
    context: event.context ?? null,
    related_object: event.related_object
      ? { id: event.related_object.id ?? null, type: event.related_object.type ?? null }
      : null,
  };
}
