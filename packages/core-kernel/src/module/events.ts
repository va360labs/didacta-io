/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Utilidades compartidas para publicar eventos de dominio.
 */

import { createHash } from 'node:crypto';

/**
 * Tope de la clave de idempotencia.
 *
 * `outbox_event.idempotency_key` es `text` bajo un índice único
 * (`@@unique([tenantId, idempotencyKey])`), y la fila de un índice btree de
 * Postgres no admite más de 2.704 bytes. Nos quedamos MUY por debajo: la
 * clave no está para transportar el payload, solo para distinguirlo.
 */
export const EVENT_IDEMPOTENCY_KEY_MAX_LENGTH = 256;

/** Lo que ocupa `:<32 hex>` — el resumen del payload con su separador. */
const DIGEST_PART_LENGTH = 33;

/**
 * Clave de idempotencia de un evento de dominio: acotada pase lo que pase.
 *
 * Cada módulo la componía a mano como
 * `${name}:${JSON.stringify(data)}:${Date.now()}`: el payload ENTERO viajaba
 * dentro de la clave. Mientras un payload son tres identificadores no pasa
 * nada, pero la clave crece con él, y en cuanto pasa del límite del índice el
 * INSERT del outbox revienta («index row size … exceeds btree version 4
 * maximum 2704»). Y revienta TARDE: la fila de negocio ya está escrita, así
 * que la acción se hizo, el usuario ve un error, y el evento —con todo lo que
 * cuelga de él: avisos, webhooks, matrículas— no existe.
 *
 * No es hipotético. `zoom.session.cancelled` lleva en el payload a todos los
 * inscritos: con unas setenta personas apuntadas a una clase, cancelarla
 * dejaba la clase cancelada y a nadie avisado, sin reintento posible. Lo
 * mismo con el motivo que escribe un moderador o el error entero que devuelve
 * un proveedor de IA.
 *
 * El resumen (hash) resuelve eso sin cambiar la semántica: la unicidad la
 * daba el `uniqueSuffix` (habitualmente `Date.now()`), no el volcado del
 * payload. Dos publicaciones del mismo evento con el mismo payload en el
 * mismo instante siguen deduplicándose, igual que antes.
 *
 * Si el evento tiene un identificador natural de la ocurrencia (el pedido, el
 * intento), pásalo como `uniqueSuffix`: entonces la clave es estable de
 * verdad y un reintento no publica dos veces.
 *
 * @param name          Nombre del evento (`community.post.created`).
 * @param data          Payload del evento. Se resume, no se transporta.
 * @param uniqueSuffix  Lo que hace única esta publicación concreta.
 */
export function eventIdempotencyKey(
  name: string,
  data: unknown,
  uniqueSuffix: string | number = Date.now(),
): string {
  const digest = createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 32);
  const suffix = String(uniqueSuffix);
  const key = `${name}:${digest}:${suffix}`;
  if (key.length <= EVENT_IDEMPOTENCY_KEY_MAX_LENGTH) return key;

  // Un nombre o un sufijo kilométricos no son lo normal, pero no se da por
  // hecho. Recortar por la cola se llevaría justo lo que distingue una
  // publicación de otra (el sufijo, o el resumen), y dos eventos distintos
  // acabarían con la misma clave: el segundo se perdería en silencio. Se
  // resume la clave entera y se conserva el principio del nombre para que
  // siga siendo legible en la tabla.
  const overall = createHash('sha256').update(key).digest('hex').slice(0, 32);
  const room = EVENT_IDEMPOTENCY_KEY_MAX_LENGTH - DIGEST_PART_LENGTH;
  return `${key.slice(0, room)}:${overall}`;
}

/**
 * Serialización para el resumen: no lanza y no depende del orden de las
 * claves.
 *
 * - No lanza: un payload con una referencia circular o un BigInt no debe
 *   tumbar la publicación de un evento. Preferimos una huella peor a un
 *   evento perdido.
 * - Orden estable: `{a, b}` y `{b, a}` son el mismo payload.
 */
function stableStringify(data: unknown): string {
  try {
    return (
      JSON.stringify(data, (_key, value: unknown) => {
        if (typeof value === 'bigint') return value.toString();
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value instanceof Date)
        ) {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(value).sort()) {
            sorted[k] = (value as Record<string, unknown>)[k];
          }
          return sorted;
        }
        return value;
      }) ?? 'undefined'
    );
  } catch {
    return String(data);
  }
}
