/**
 * DRIP de lecciones — lógica pura de cálculo de disponibilidad.
 *
 * Modelo de intervalo RELATIVO: la unidad nº i (lección o módulo, en orden) se
 * libera a `ancla + startOffsetDays + i × intervalDays` días. El ancla es la
 * fecha de entrada del alumno al curso. Si a un alumno le aplican varias reglas
 * (porque está en un tier Y en un grupo con drip), gana la MÁS PERMISIVA: la
 * fecha de desbloqueo más temprana por lección.
 *
 * Sin reglas aplicables → mapa vacío = todo disponible (sin drip).
 *
 * Funciones puras y sin dependencias para poder testearlas sin DB.
 */

export type DripUnit = 'LESSON' | 'MODULE';
export type DripAudienceKind = 'TIER' | 'GROUP';

/** Lección con su posición global (lessonIndex) y la de su módulo (moduleIndex). */
export interface OrderedLesson {
  lessonId: string;
  lessonIndex: number;
  moduleIndex: number;
}

/** Una regla de drip aplicable al alumno (derivada de un schedule activo). */
export interface DripRule {
  unit: DripUnit;
  intervalDays: number;
  startOffsetDays: number;
}

export interface LessonAvailability {
  /** Fecha de desbloqueo (la más temprana entre las reglas aplicables). */
  availableAt: Date;
  /** ¿Ya está disponible a fecha `now`? */
  available: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Calcula, por lección, su fecha de desbloqueo y si ya está disponible.
 * Devuelve un mapa SOLO con las lecciones afectadas por drip. Si no hay reglas,
 * devuelve un mapa vacío (el caller interpreta "sin entrada" = disponible).
 */
export function computeDripAvailability(
  lessons: OrderedLesson[],
  rules: DripRule[],
  anchor: Date,
  now: Date,
): Map<string, LessonAvailability> {
  const out = new Map<string, LessonAvailability>();
  if (rules.length === 0) return out;

  const anchorMs = anchor.getTime();
  const nowMs = now.getTime();

  for (const lesson of lessons) {
    let earliestMs: number | null = null;
    for (const rule of rules) {
      const index = rule.unit === 'MODULE' ? lesson.moduleIndex : lesson.lessonIndex;
      const offsetDays = rule.startOffsetDays + index * rule.intervalDays;
      const at = anchorMs + offsetDays * MS_PER_DAY;
      if (earliestMs === null || at < earliestMs) earliestMs = at;
    }
    if (earliestMs !== null) {
      out.set(lesson.lessonId, {
        availableAt: new Date(earliestMs),
        available: earliestMs <= nowMs,
      });
    }
  }
  return out;
}
