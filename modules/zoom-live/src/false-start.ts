/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ZoomWebhookEvent } from './dto.js';

/**
 * Un `meeting.started` que ocurre con la clase tan lejos no es la clase: es
 * alguien que abrió la reunión fuera de hora (el formador probando el enlace,
 * o preparando la sala la víspera). Con menos margen sí puede serlo: hay
 * formadores que abren un rato antes para ir recibiendo a la gente.
 */
export const EARLY_EVENT_MARGIN_MINUTES = 30;

/**
 * Lo que queda escrito en `mod_zoom_live_webhook_event.error_message` cuando un
 * aviso se archiva sin aplicar por haber ocurrido fuera de la hora de la clase.
 * Es un CÓDIGO estable, no un texto: lo traduce la web (es/en) en el listado de
 * avisos, para que el admin vea por qué ese `meeting.ended` no cerró la clase.
 */
export const OUT_OF_SCHEDULE_NOTE = 'ZOOM_EVENT_OUT_OF_SCHEDULE';

/**
 * ¿Es este aviso de Zoom de una reunión abierta FUERA DE HORA, y no de la clase?
 *
 * Sin esta comprobación, cualquier `meeting.ended` cerraba la clase: bastaba
 * con que el formador abriese la reunión días antes para probarla y la cerrase.
 * La clase quedaba «terminada» —sin botón para entrar el día de verdad y con
 * las inscripciones cerradas—, se mandaba la encuesta post-clase a todos los
 * inscritos y, si Zoom había grabado, se colgaba la grabación de la prueba.
 *
 * Reglas:
 *  - `meeting.started` más de `EARLY_EVENT_MARGIN_MINUTES` antes de la hora.
 *  - `meeting.ended` antes de la hora de inicio: una clase no termina antes de
 *    empezar (cubre también al formador que entra a preparar y se va).
 *  - `recording.completed` de una grabación que acabó antes de la hora de
 *    inicio. Zoom manda el fin de cada tramo en `recording_files`; si no viene,
 *    se usa el momento del aviso.
 *
 * El «cuándo» es el del SUCESO (`event_ts`, que viene firmado por Zoom), no el
 * de llegada: Zoom reintenta durante un par de horas, y un `meeting.ended` de
 * una prueba hecha poco antes de la clase podría llegar con la clase ya
 * empezada. Nunca se acepta un `event_ts` posterior a `now`: sin él, o si viene
 * adelantado, cuenta el momento de llegada.
 */
export function isFalseStart(
  event: Pick<ZoomWebhookEvent, 'event' | 'event_ts' | 'payload'>,
  startTime: Date,
  now: Date,
): boolean {
  const start = startTime.getTime();
  const occurredAt = occurredAtMs(event, now);
  switch (event.event) {
    case 'meeting.started':
      return occurredAt < start - EARLY_EVENT_MARGIN_MINUTES * 60 * 1000;
    case 'meeting.ended':
      return occurredAt < start;
    case 'recording.completed': {
      const ends = recordingEndTimes(event.payload?.object?.recording_files);
      const recordingEnd = ends.length > 0 ? Math.max(...ends) : occurredAt;
      return recordingEnd < start;
    }
    default:
      return false;
  }
}

function occurredAtMs(event: Pick<ZoomWebhookEvent, 'event_ts'>, now: Date): number {
  const arrived = now.getTime();
  const ts = event.event_ts;
  return typeof ts === 'number' && ts > 0 ? Math.min(ts, arrived) : arrived;
}

/**
 * Fin de cada tramo de grabación, en ms. Lee `recording_files` a la defensiva
 * (viene sin validar a propósito, ver el schema): cualquier cosa que no sea una
 * fecha se ignora en vez de tirar el aviso.
 */
function recordingEndTimes(files: unknown): number[] {
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => {
      const end = (file as { recording_end?: unknown } | null)?.recording_end;
      return typeof end === 'string' ? Date.parse(end) : NaN;
    })
    .filter((t) => Number.isFinite(t));
}
