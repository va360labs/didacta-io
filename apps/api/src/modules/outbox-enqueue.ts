/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { EnqueueOutcome, OutboxJobRef } from './persistent-event-bus';

/**
 * Estados de BullMQ desde los que un job **ya no va a ejecutarse nunca**.
 *
 * `completed` y `failed` son terminales por definición; `unknown` es lo que
 * devuelve `getState()` cuando el hash del job no existe (lo purgó
 * `removeOnComplete`/`removeOnFail` entre el `add` y la consulta), y desde ahí
 * tampoco va a correr nada.
 *
 * El resto (`waiting`, `active`, `delayed`, `prioritized`,
 * `waiting-children`) significa «hay un job que acabará llamando a
 * `processOutboxId`», que es justo lo que necesitamos saber.
 */
const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'unknown']);

/**
 * Identidad del job de despacho de una fila del outbox.
 *
 * ── Por qué NO basta el id ───────────────────────────────────────────────────
 * `outbox_event.id` es un BIGSERIAL. BullMQ deduplica **en silencio** un `add`
 * cuyo `jobId` ya existe como clave en Redis — y las claves sobreviven al
 * final del job (`removeOnComplete` 24 h, `removeOnFail` 7 d). Con el id
 * pelado, recrear la base sin vaciar Redis reinicia la secuencia en 1, los
 * eventos nuevos chocan con jobs viejos ya terminados y **no se despachan
 * jamás**. Reproducido: job `outbox-1` en Redis con `finishedOn`, 53 filas
 * clavadas en pendiente con `attempts=0`.
 *
 * ── Por qué `createdAt` y no un uuid ─────────────────────────────────────────
 * La deduplicación tiene que seguir funcionando: el mismo evento lo encolan el
 * `publish()` y el barrido de recuperación, y desde procesos distintos (varias
 * réplicas de la API). Un uuid aleatorio por llamada haría que cada intento
 * fuese un job nuevo → despacho duplicado. La identidad debe ser **derivable
 * de la fila**, igual para todo el que la lea, y no reiniciable: `(id,
 * createdAt)` cumple las tres. Dos filas distintas no pueden compartir el par,
 * y una base recreada no puede reproducirlo salvo restaurando un backup — en
 * cuyo caso son literalmente el mismo evento y deduplicar es lo correcto.
 *
 * El prefijo `outbox-` no es decorativo: BullMQ rechaza custom ids que sean
 * enteros puros («Custom Ids cannot be integers»).
 */
export function buildOutboxJobId(ref: OutboxJobRef): string {
  return `outbox-${ref.id.toString()}-${ref.createdAt.getTime()}`;
}

/** Job de BullMQ, reducido a lo único que el encolado necesita consultar. */
export interface OutboxJobHandle {
  getState(): Promise<string>;
}

/**
 * Superficie mínima de la `Queue` de BullMQ que usa el encolado. Existe para
 * que el camino degradado (colisión con un job terminal) sea probable sin
 * Redis: la implementación real es una lambda sobre `Queue` en
 * `OutboxQueueService`.
 */
export interface OutboxJobQueuePort {
  /**
   * Añade el job de despacho bajo ese `jobId`. Ojo: si el id ya existe BullMQ
   * **no añade nada** y devuelve el job existente, sin señalarlo de ninguna
   * forma al llamante (el script Lua `addStandardJob` hace
   * `if EXISTS(jobIdKey) then handleDuplicatedJob(...)` y devuelve el mismo id).
   * De ahí que haya que preguntar por el estado en vez de fiarse del retorno.
   */
  add(jobId: string): Promise<OutboxJobHandle>;
  /** Retira el job. Devuelve cuántos se retiraron (0 = no se pudo). */
  remove(jobId: string): Promise<number>;
}

/** Avisos del camino degradado. Los cablea el servicio a logs y métricas. */
export interface EnqueueCollisionReport {
  /** Había un job terminal ocupando el id: se retiró y se reencoló. Entregable. */
  onReplaced?(jobId: string): void;
  /** El id sigue ocupado por un job terminal. El evento NO se despachará. */
  onSwallowed?(jobId: string): void;
}

/**
 * Encola el despacho de una fila del outbox y **confirma que el job resultante
 * va a ejecutarse**.
 *
 * La confirmación no es paranoia: `queue.add()` con un `jobId` ya usado
 * devuelve un job de aspecto idéntico al recién creado, así que sin preguntar
 * por el estado no hay manera de distinguir «encolado» de «tragado». Y tragado
 * pasa de verdad en dos escenarios, no sólo en el de la base recreada que
 * `buildOutboxJobId` cierra:
 *
 *  - un job que agotó sus 5 intentos queda en el set de fallidos **7 días**:
 *    cualquier reintento del failsafe sobre esa misma fila se descartaba en
 *    silencio durante toda la retención, justo cuando más falta hacía;
 *  - un job completado cuya fila quedó pendiente (proceso muerto entre el
 *    despacho y el `UPDATE`) bloquea el reintento 24 h.
 *
 * Por eso, ante un id ocupado por un job terminal, se **retira y se reencola**:
 * el failsafe vuelve a poder entregar, no sólo informar. Si ni así se consigue,
 * se devuelve `deduplicated` — que es lo que impide que el llamante lo cuente
 * como entregado.
 */
export async function enqueueOutboxJob(
  queue: OutboxJobQueuePort,
  ref: OutboxJobRef,
  report: EnqueueCollisionReport = {},
): Promise<EnqueueOutcome> {
  const jobId = buildOutboxJobId(ref);

  if (await addAndConfirm(queue, jobId)) return 'queued';

  // El id lo ocupa un job terminal. Retirarlo libera la clave para que el
  // segundo `add` cree un job de verdad. `remove()` no puede llevarse por
  // delante un job en vuelo: sólo llegamos aquí si el estado ES terminal.
  try {
    await queue.remove(jobId);
  } catch {
    // Da igual por qué falló: el `add` siguiente lo dirá mejor que el error.
  }

  if (await addAndConfirm(queue, jobId)) {
    report.onReplaced?.(jobId);
    return 'queued';
  }

  report.onSwallowed?.(jobId);
  return 'deduplicated';
}

/** Añade el job y responde si quedó en un estado desde el que llegará a correr. */
async function addAndConfirm(queue: OutboxJobQueuePort, jobId: string): Promise<boolean> {
  const job = await queue.add(jobId);
  return !TERMINAL_JOB_STATES.has(await job.getState());
}
