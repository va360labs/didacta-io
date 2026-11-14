/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lectura tolerante de los objetos de Stripe que CAMBIARON DE FORMA entre
 * versiones de su API.
 *
 * El problema, encontrado en producción el 16-ago-2026: el SDK fija
 * `apiVersion: '2024-12-18.acacia'` para las LLAMADAS, pero **los webhooks se
 * entregan con la versión por defecto de la CUENTA de Stripe**, que en la
 * cuenta real era `2025-12-15.clover`. Dos formas distintas del mismo objeto
 * entrando por dos puertas distintas al mismo código.
 *
 * Lo que se rompió, en silencio y en producción:
 *
 *   - `invoice.subscription` desapareció (ahora cuelga de
 *     `parent.subscription_details.subscription`). Como el handler empezaba con
 *     `if (!invoice.subscription) return;`, **TODOS los `invoice.paid` y
 *     `invoice.payment_failed` se descartaban**: cero facturas guardadas (el
 *     historial del alumno vacío para siempre), el impago no marcaba nunca
 *     PAST_DUE —o sea, quien dejaba de pagar conservaba el acceso— y el trial
 *     nunca convertía a ACTIVE.
 *   - `subscription.current_period_end` desapareció de la raíz (ahora está en
 *     `items.data[].current_period_end`), así que la fecha de renovación se
 *     guardaba `null` en cada evento.
 *
 * No vale con arreglarlo en el dashboard de Stripe fijando la versión del
 * endpoint: Didacta la instala cada cual con SU cuenta de Stripe y su versión
 * por defecto, así que el código tiene que aguantar las dos formas. Y por eso
 * estas funciones NO se apoyan en los tipos del SDK (que describen solo la
 * versión fijada): leen sobre `unknown` a mano.
 */

/** Un id de Stripe puede venir como string o como el objeto ya expandido. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/**
 * Id de la suscripción a la que pertenece una invoice, en cualquiera de las dos
 * formas. Devuelve null si la invoice es suelta (no de suscripción), que es un
 * caso legítimo y no un error.
 */
export function subscriptionIdFromInvoice(invoice: unknown): string | null {
  if (!invoice || typeof invoice !== 'object') return null;
  const inv = invoice as {
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } };
  };
  // Forma antigua (≤ 2025-03-31): `subscription` en la raíz.
  const directo = idOf(inv.subscription);
  if (directo) return directo;
  // Forma nueva (`parent` discrimina de qué nace la invoice).
  return idOf(inv.parent?.subscription_details?.subscription);
}

/**
 * Fin del periodo en curso (epoch en segundos) de una suscripción, en
 * cualquiera de las dos formas.
 *
 * En la forma nueva el dato es POR LÍNEA, porque cada item puede tener su
 * propio ciclo. Didacta vende una línea por suscripción (`line_items` de un
 * solo precio), así que la primera es la buena; se coge el máximo para que, si
 * algún día hay varias, la fecha no se quede corta y el acceso caduque antes
 * de tiempo.
 */
export function currentPeriodEndFromSubscription(subscription: unknown): number | null {
  if (!subscription || typeof subscription !== 'object') return null;
  const sub = subscription as {
    current_period_end?: unknown;
    items?: { data?: Array<{ current_period_end?: unknown }> };
  };
  if (typeof sub.current_period_end === 'number') return sub.current_period_end;
  const finesDeItem = (sub.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((v): v is number => typeof v === 'number');
  if (finesDeItem.length === 0) return null;
  return Math.max(...finesDeItem);
}

/** `Date` a partir del epoch en segundos, o null. Azucarillo de los dos de arriba. */
export function toDateOrNull(epochSeconds: number | null): Date | null {
  return epochSeconds === null ? null : new Date(epochSeconds * 1000);
}

/**
 * Inicio del periodo en curso (epoch en segundos), en cualquiera de las dos
 * formas (raíz antes de `basil`, por línea después). Con varias líneas, el
 * mínimo: el periodo empezó cuando empezó la primera.
 */
export function currentPeriodStartFromSubscription(subscription: unknown): number | null {
  if (!subscription || typeof subscription !== 'object') return null;
  const sub = subscription as {
    current_period_start?: unknown;
    items?: { data?: Array<{ current_period_start?: unknown }> };
  };
  if (typeof sub.current_period_start === 'number') return sub.current_period_start;
  const iniciosDeItem = (sub.items?.data ?? [])
    .map((item) => item.current_period_start)
    .filter((v): v is number => typeof v === 'number');
  if (iniciosDeItem.length === 0) return null;
  return Math.min(...iniciosDeItem);
}

/**
 * Meses que cubre cada cobro de la suscripción (mensual = 1, trimestral = 3,
 * anual = 12), leídos del precio de su primera línea (`price.recurring`, o
 * `plan` en versiones viejas). `null` si se cobra por semanas o días, o si no
 * se puede leer: la pausa y el descuento por meses no aplican.
 */
export function intervalMonthsFromSubscription(subscription: unknown): number | null {
  if (!subscription || typeof subscription !== 'object') return null;
  const sub = subscription as {
    items?: {
      data?: Array<{
        price?: { recurring?: { interval?: unknown; interval_count?: unknown } | null } | null;
        plan?: { interval?: unknown; interval_count?: unknown } | null;
      }>;
    };
  };
  const item = sub.items?.data?.[0];
  const recurring = item?.price?.recurring ?? item?.plan ?? null;
  if (!recurring) return null;
  const count =
    typeof recurring.interval_count === 'number' && recurring.interval_count > 0
      ? recurring.interval_count
      : 1;
  if (recurring.interval === 'month') return count;
  if (recurring.interval === 'year') return count * 12;
  return null;
}

/** `pause_collection` de una suscripción (`null` = cobrando con normalidad). */
export function pauseCollectionFromSubscription(
  subscription: unknown,
): { behavior: string; resumesAt: number | null } | null {
  if (!subscription || typeof subscription !== 'object') return null;
  const pause = (subscription as { pause_collection?: unknown }).pause_collection;
  if (!pause || typeof pause !== 'object') return null;
  const { behavior, resumes_at } = pause as { behavior?: unknown; resumes_at?: unknown };
  return {
    behavior: typeof behavior === 'string' ? behavior : 'void',
    resumesAt: typeof resumes_at === 'number' ? resumes_at : null,
  };
}

/**
 * ¿La suscripción tiene ya algún descuento vivo? `discount` (un solo cupón,
 * versiones viejas) o `discounts` (lista, desde 2024): cualquiera de los dos
 * no vacío.
 */
export function subscriptionHasDiscount(subscription: unknown): boolean {
  if (!subscription || typeof subscription !== 'object') return false;
  const sub = subscription as { discount?: unknown; discounts?: unknown };
  if (sub.discount) return true;
  return Array.isArray(sub.discounts) && sub.discounts.length > 0;
}
