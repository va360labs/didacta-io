/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import type { ZoomWebhookEvent } from './dto.js';

/** Prefijo de las claves que calcula Didacta (Zoom no las mandó). */
export const DERIVED_EVENT_KEY_PREFIX = 'derived-';

/**
 * Clave de idempotencia de un aviso de Zoom: lo que se guarda en
 * `mod_zoom_live_webhook_event.event_id` (UNIQUE) para que una reentrega no se
 * aplique dos veces.
 *
 * Zoom NO manda `event_id` en el cuerpo de sus avisos (su forma es
 * `{ event, event_ts, payload }`; visto en `meeting.started` y
 * `meeting.ended` reales), así que la clave no puede depender de él. Se deriva
 * de lo que identifica al SUCESO y que una reentrega repite tal cual:
 *
 *   tipo de aviso · `event_ts` (cuándo ocurrió, en ms) · cuenta · id de la
 *   reunión · uuid de la ocurrencia
 *
 * Una reentrega de Zoom (reintenta si no recibe 2xx en 3 s) trae los mismos
 * cinco valores → misma clave → DUPLICATE. Dos sucesos distintos difieren al
 * menos en uno: `meeting.started` y `meeting.ended` en el tipo, dos ocurrencias
 * de una reunión recurrente en el uuid y en el `event_ts`.
 *
 * No se usa ninguna cabecera de la petición (`x-zm-request-id`,
 * `x-zm-trackingid`): identifican la ENTREGA, no el suceso, y una clave que
 * cambia en cada reintento no deduplica nada.
 *
 * Casos particulares:
 *  - Si el cuerpo SÍ trae `event_id` (payloads hechos a mano, tests, filas ya
 *    guardadas), se usa tal cual: no cambia nada para quien ya lo mandaba.
 *  - Sin `event_ts` no hay con qué distinguir dos sucesos del mismo tipo sobre
 *    la misma reunión; se usa entonces el cuerpo crudo entero (`rawBody`), que
 *    una reentrega también repite. Sin ninguno de los dos queda la tupla sin
 *    fecha: dos avisos iguales del mismo tipo y ocurrencia se tratan como uno.
 *  - Los avisos que no se aplican (`meeting.participant_joined`…) solo se
 *    archivan. Dos participantes entrando en el mismo milisegundo darían la
 *    misma clave y el segundo no dejaría rastro: se acepta, no tienen efecto.
 */
export function webhookEventKey(event: ZoomWebhookEvent, rawBody?: string): string {
  if (event.event_id) return event.event_id;

  if (typeof event.event_ts !== 'number' && rawBody) {
    return DERIVED_EVENT_KEY_PREFIX + sha256(`body:${rawBody}`);
  }

  const object = event.payload?.object;
  const identity = JSON.stringify([
    event.event,
    event.event_ts ?? null,
    event.payload?.account_id ?? null,
    object?.id !== undefined ? String(object.id) : null,
    object?.uuid ?? null,
  ]);
  return DERIVED_EVENT_KEY_PREFIX + sha256(`event:${identity}`);
}

/** 40 hex (160 bits): de sobra para no colisionar y cabe cómodo en un listado. */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 40);
}
