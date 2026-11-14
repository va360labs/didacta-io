/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { RetentionMember } from './ports.js';
import { addDays, addYears, DAY_MS, fullYearsBetween, utcDayKey } from './schedule.js';

/**
 * A quién le toca cada mensaje que depende del tiempo (bienvenida, a los N
 * días, recuperación, aniversario). Funciones puras: reciben los miembros y
 * devuelven las ocurrencias; la clave de cada ocurrencia es la que la tabla
 * hace única, así que volver a calcularlas cada 5 minutos no duplica nada.
 *
 * REGLA COMÚN — «desde que se activa, no hacia atrás»: solo cuenta lo que
 * pasa DESPUÉS de activar el mensaje (`activatedAt`). Encender «a los 30 días»
 * en un aula con 500 miembros antiguos no les escribe a los 500 a la vez: le
 * escribe a cada uno cuando cumpla sus 30 días a partir de hoy.
 */

/**
 * Margen para ponerse al día si el barrido estuvo parado (un despliegue, un
 * corte de Redis). Más allá, el momento ya pasó y no se manda.
 */
export const CATCH_UP_MS = 3 * DAY_MS;

/** La recuperación admite más margen: el umbral se cruza una sola vez por episodio. */
export const INACTIVE_CATCH_UP_MS = 14 * DAY_MS;

export interface Occurrence {
  userId: string;
  occurrenceKey: string;
  /** Contexto que el envío necesitará (curso, nivel, referencia de actividad…). */
  context: Record<string, unknown>;
}

function eligible(m: RetentionMember): boolean {
  return !m.isStaff;
}

/** Para lo que cuenta desde el alta: una cuenta importada no «llegó» ese día. */
function joinedHere(m: RetentionMember): boolean {
  return eligible(m) && !m.imported;
}

function inRange(at: number, from: number, to: number): boolean {
  return at >= from && at <= to;
}

/** Bienvenida: altas desde que se activó (y de los últimos 3 días como mucho). */
export function welcomeOccurrences(
  members: readonly RetentionMember[],
  activatedAt: Date,
  now: Date,
): Occurrence[] {
  const from = Math.max(activatedAt.getTime(), now.getTime() - CATCH_UP_MS);
  return members
    .filter((m) => joinedHere(m) && inRange(m.joinedAt.getTime(), from, now.getTime()))
    .map((m) => ({ userId: m.id, occurrenceKey: 'join', context: {} }));
}

/** «A los N días»: a quien cumple N días de alta desde que se activó. */
export function daysAfterJoinOccurrences(
  members: readonly RetentionMember[],
  days: number,
  activatedAt: Date,
  now: Date,
): Occurrence[] {
  const from = Math.max(activatedAt.getTime(), now.getTime() - CATCH_UP_MS);
  return members
    .filter(
      (m) => joinedHere(m) && inRange(addDays(m.joinedAt, days).getTime(), from, now.getTime()),
    )
    .map((m) => ({ userId: m.id, occurrenceKey: `day:${days}`, context: {} }));
}

/** Referencia de actividad: la última vez que entró o, si nunca, el alta. */
export function activityReference(m: RetentionMember): Date {
  return m.lastActiveAt ?? m.joinedAt;
}

/** Clave del episodio de inactividad: el día (UTC) de su última actividad. */
export function inactiveEpisodeKey(reference: Date): string {
  return `inactive:${utcDayKey(reference)}`;
}

/**
 * «Si no entra en N días»: a quien CRUZA el umbral desde que se activó.
 * Quien ya llevaba meses sin entrar al activarlo no recibe nada (para eso está
 * «Añadir a recuperación» en Miembros en riesgo). Cada vuelta al aula abre un
 * episodio nuevo con su propia clave, así que quien vuelve y se va otra vez
 * puede recibirlo de nuevo.
 *
 * Reenvío (una sola vez por episodio): si el primero salió hace
 * `resendAfterDays` y la persona sigue sin entrar (la referencia es la misma).
 */
export function inactiveOccurrences(
  members: readonly RetentionMember[],
  days: number,
  resendAfterDays: number | null,
  activatedAt: Date,
  now: Date,
  /** Primeros envíos ya hechos de este mensaje: userId → { clave, enviado }. */
  firstSends: ReadonlyMap<string, { occurrenceKey: string; sentAt: Date }>,
): Occurrence[] {
  const from = Math.max(activatedAt.getTime(), now.getTime() - INACTIVE_CATCH_UP_MS);
  const out: Occurrence[] = [];
  for (const m of members) {
    if (!eligible(m)) continue;
    const reference = activityReference(m);
    const key = inactiveEpisodeKey(reference);
    const crossing = addDays(reference, days).getTime();
    if (inRange(crossing, from, now.getTime())) {
      out.push({
        userId: m.id,
        occurrenceKey: key,
        context: { reference: reference.toISOString() },
      });
    }
    if (resendAfterDays && resendAfterDays > 0) {
      const first = firstSends.get(m.id);
      if (
        first &&
        first.occurrenceKey === key &&
        addDays(first.sentAt, resendAfterDays).getTime() <= now.getTime()
      ) {
        out.push({
          userId: m.id,
          occurrenceKey: `${key}:resend`,
          context: { reference: reference.toISOString(), resend: true },
        });
      }
    }
  }
  return out;
}

/**
 * Aniversario de la suscripción o membresía: el día que se cumplen 1, 2, 3…
 * años desde que empezó. Una persona con varias cuenta la más antigua.
 */
export function anniversaryOccurrences(
  starts: ReadonlyArray<{ userId: string; startedAt: Date }>,
  members: ReadonlyMap<string, RetentionMember>,
  activatedAt: Date,
  now: Date,
): Occurrence[] {
  const earliest = new Map<string, Date>();
  for (const s of starts) {
    const prev = earliest.get(s.userId);
    if (!prev || s.startedAt < prev) earliest.set(s.userId, s.startedAt);
  }
  const from = Math.max(activatedAt.getTime(), now.getTime() - CATCH_UP_MS);
  const out: Occurrence[] = [];
  for (const [userId, startedAt] of earliest) {
    const m = members.get(userId);
    if (!m || !eligible(m)) continue;
    const years = fullYearsBetween(startedAt, now);
    if (years < 1) continue;
    const at = addYears(startedAt, years).getTime();
    if (inRange(at, from, now.getTime())) {
      out.push({ userId, occurrenceKey: `anniversary:${years}`, context: { years } });
    }
  }
  return out;
}
