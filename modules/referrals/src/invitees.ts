/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lista de invitados del miembro («Tus invitados» en Invita y gana).
 *
 * Funciones PURAS: derivan el estado de cada invitado y sus iniciales sin
 * tocar la base de datos, para poder fijarlas con tests. Nunca exponen nombre
 * completo ni correo: solo iniciales.
 */

export type InviteeState = 'trial' | 'paying' | 'bought_course' | 'cancelled' | 'joined';

/** Estados de una suscripción tal y como los guarda `mod.subscriptions`. */
export type SubscriptionStatusLike =
  | 'PENDING'
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'UNPAID'
  | 'CANCELED';

export interface InviteeFacts {
  /** Suscripciones del invitado en esta aula (cualquiera, con su fecha). */
  subscriptions: ReadonlyArray<{ status: SubscriptionStatusLike | string; createdAt: Date }>;
  /** ¿Tiene alguna compra suelta (curso) no anulada atribuida a este enlace? */
  hasCoursePurchase: boolean;
}

/**
 * Estado de un invitado. Regla, en este orden:
 *
 * 1. Con su suscripción MÁS RECIENTE (las PENDING, que son pagos sin cerrar,
 *    no cuentan):
 *    - TRIALING → «En prueba» (`trial`).
 *    - ACTIVE o PAST_DUE → «Pagando» (`paying`): la suscripción sigue viva;
 *      PAST_DUE es un cobro que Stripe aún reintenta.
 * 2. Si no hay suscripción viva y compró algo suelto (comisión de pedido no
 *    anulada, o referido nacido de un pedido que no devengó comisión) →
 *    «Compró un curso» (`bought_course`).
 * 3. Si tuvo suscripción y ya no está viva (CANCELED o UNPAID) → «Se dio de
 *    baja» (`cancelled`).
 * 4. Si no hay nada de lo anterior (por ejemplo, una compra que se reembolsó
 *    entera) → «Sin compras ahora» (`joined`).
 */
export function deriveInviteeState(facts: InviteeFacts): InviteeState {
  const subs = facts.subscriptions
    .filter((s) => s.status !== 'PENDING')
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = subs[0];
  if (latest?.status === 'TRIALING') return 'trial';
  if (latest?.status === 'ACTIVE' || latest?.status === 'PAST_DUE') return 'paying';
  if (facts.hasCoursePurchase) return 'bought_course';
  if (latest) return 'cancelled';
  return 'joined';
}

/**
 * Iniciales de un nombre: primera letra de las dos primeras palabras, en
 * mayúsculas («María Pérez Gil» → «MP»; «lucía» → «L»). Sin nombre, «·».
 * Nunca devuelve el nombre ni el correo.
 */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return '·';
  return words
    .slice(0, 2)
    .map((w) => (w.match(/\p{L}/u)?.[0] ?? '').toLocaleUpperCase('es'))
    .join('');
}
