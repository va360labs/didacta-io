/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Horas y evidencias de seguimiento de un participante (LMS-121).
 *
 * ── Por qué existe este fichero ──────────────────────────────────────────────
 *
 * Hasta ahora las horas que Didacta exportaba a Fundae salían de una regla sola:
 *
 *     horasAsistidas = horasFormacion × progressPercent / 100
 *
 * y `progressPercent` era el porcentaje de lecciones con la casilla marcada. Esa
 * casilla la ponía el alumno. Es decir: las horas bonificadas se calculaban a
 * partir de una autodeclaración, y la instrucción de seguimiento de Fundae pide
 * justo lo contrario — registros de interacción, navegación por el itinerario y
 * realización efectiva de las actividades.
 *
 * Aquí las horas se reconstruyen lección a lección desde lo que el servidor sí
 * registró: `watched_seconds`, `first_accessed_at`, `last_accessed_at` y, desde
 * LMS-121, `completion_source` (quién dio la lección por hecha).
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 * Cada lección aporta como mucho su duración declarada (`nominal`):
 *
 *   · Dada por completada → aporta `nominal`. Hace falta que sea así y no el
 *     tiempo visto: un cuestionario lo cierra el puente de evaluaciones con
 *     `watchedSeconds: 0`, de modo que contar solo permanencia dejaría a cero
 *     un curso hecho de cuestionarios.
 *   · A medias → aporta el tiempo REALMENTE registrado, topado a `nominal`. El
 *     tope evita que una pestaña olvidada una noche entera valga 8 horas.
 *
 * Nótese lo que NO decide la procedencia: cuánto suma. Descontar de golpe las
 * lecciones autodeclaradas (`SELF`, y el `null` de las filas anteriores a
 * LMS-121, cerradas sin registrar procedencia) dejaría a cero el histórico de
 * toda academia que ya esté operando, y ese no es nuestro sitio para decidirlo.
 * Lo que sí hace la procedencia es viajar: esas horas van contadas aparte en
 * `horasSinVerificar` y el paquete de auditoría las declara como tales. Quien
 * firma la bonificación ve, antes de firmar, cuánto de lo que declara se apoya
 * en registros de interacción y cuánto en la palabra del alumno.
 */

/** Finalizaciones que un tercero verificó. `SELF` y `null` quedan fuera a propósito. */
const VERIFIED_SOURCES: ReadonlySet<string> = new Set(['TIME', 'ASSESSMENT', 'SCORM', 'INSTRUCTOR']);

/** Tipos de lección que la instrucción de seguimiento cuenta como «actividad de aprendizaje». */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set(['QUIZ', 'SCORM']);

/**
 * Tipos que cuentan como «control periódico».
 *
 * La instrucción pide DOS porcentajes distintos —75 % de actividades de
 * aprendizaje, y 75 % de horas y de controles periódicos para dar al
 * participante por finalizado— y hoy el modelo de datos no deja marcar una
 * lección como control: no existe ese campo. El mapeo que hacemos es el único
 * que se sostiene con lo que hay: un control es una evaluación con veredicto, o
 * sea un cuestionario. Un SCORM cuenta como actividad pero no como control,
 * porque lo que reporta es que su contenido se recorrió, no que se superara una
 * prueba.
 *
 * ⚠️ Si una academia organiza sus controles de otra forma, este numerador no la
 * representa. Marcar la lección explícitamente como control es lo que falta, y
 * está anotado como tal — no se disimula detrás de un número.
 */
const CONTROL_TYPES: ReadonlySet<string> = new Set(['QUIZ']);

/** Una lección del curso con el progreso del participante pegado (o vacío si nunca la abrió). */
export interface LessonEvidence {
  lessonId: string;
  lessonTitle: string;
  moduleTitle: string;
  /** Orden dentro del itinerario, 1..N. Es la «navegación» que pide la instrucción. */
  position: number;
  type: string;
  durationMinutes: number | null;
  watchedSeconds: number;
  completed: boolean;
  /** `null` = fila anterior a LMS-121 o autodeclarada sin respaldo. */
  completionSource: string | null;
  firstAccessedAt: Date | null;
  lastAccessedAt: Date | null;
  completedAt: Date | null;
}

export interface ParticipantEvidence {
  /** Horas defendibles: suma de los créditos por lección, topada a las horas de la acción. */
  horasAsistidas: number;
  /** De las anteriores, cuántas descansan en una autodeclaración sin verificar. */
  horasSinVerificar: number;
  /** Lo que devolvía la fórmula vieja. Se conserva para poder comparar y explicar el salto. */
  horasDeclaradasPorProgreso: number;
  /** Segundos brutos de interacción registrados por el servidor, sin topar. */
  segundosRegistrados: number;
  leccionesTotales: number;
  leccionesIniciadas: number;
  leccionesCompletadas: number;
  /** Completadas con respaldo de un tercero. El numerador honesto. */
  leccionesVerificadas: number;
  /** Actividades de aprendizaje (cuestionarios y SCORM) del itinerario. */
  actividadesTotales: number;
  actividadesSuperadas: number;
  /** Controles periódicos (cuestionarios). Subconjunto de las actividades. */
  controlesTotales: number;
  controlesSuperados: number;
  /** % de horas sobre las de la acción. Criterio de finalización de la instrucción. */
  pctHoras: number;
  /** % de actividades superadas. 100 si el curso no tiene ninguna. */
  pctActividades: number;
  /** % de controles periódicos superados. 100 si el curso no tiene ninguno. */
  pctControles: number;
  primerAccesoAt: Date | null;
  ultimoAccesoAt: Date | null;
}

/**
 * Reconstruye las horas de UN participante desde su rastro de interacción.
 *
 * @param lessons  Todas las lecciones del curso, con el progreso pegado. Las no
 *                 empezadas se pasan igual (a cero): son el denominador.
 * @param horasFormacion  Horas de la acción formativa comunicadas a Fundae.
 * @param progressPercent Porcentaje que calcula mod.learning, solo para el
 *                        campo comparativo `horasDeclaradasPorProgreso`.
 */
export function computeParticipantEvidence(
  lessons: readonly LessonEvidence[],
  horasFormacion: number,
  progressPercent: number,
): ParticipantEvidence {
  const totalSeconds = Math.max(0, horasFormacion) * 3600;

  // Reparto por defecto para las lecciones sin duración declarada: las horas de
  // la acción a partes iguales. Es una estimación, y por eso solo entra donde no
  // hay dato mejor; si el curso declara duraciones, no se usa.
  const fallbackNominal = lessons.length > 0 ? totalSeconds / lessons.length : 0;

  let creditedSeconds = 0;
  let unverifiedSeconds = 0;
  let rawSeconds = 0;
  let started = 0;
  let completed = 0;
  let verified = 0;
  let activities = 0;
  let activitiesPassed = 0;
  let controls = 0;
  let controlsPassed = 0;
  let firstAccess: Date | null = null;
  let lastAccess: Date | null = null;

  for (const lesson of lessons) {
    const nominal =
      lesson.durationMinutes !== null && lesson.durationMinutes > 0
        ? lesson.durationMinutes * 60
        : fallbackNominal;

    const watched = Math.max(0, lesson.watchedSeconds);
    rawSeconds += watched;

    if (watched > 0 || lesson.firstAccessedAt !== null) started += 1;
    if (lesson.completed) completed += 1;

    const isVerified = lesson.completed && lesson.completionSource !== null
      ? VERIFIED_SOURCES.has(lesson.completionSource)
      : false;
    if (isVerified) verified += 1;

    if (ACTIVITY_TYPES.has(lesson.type)) {
      activities += 1;
      // Una actividad solo cuenta como superada si la cerró su propio motor.
      // Es exactamente el caso que la API dejaba falsear antes de LMS-121.
      if (isVerified) activitiesPassed += 1;
    }
    if (CONTROL_TYPES.has(lesson.type)) {
      controls += 1;
      if (isVerified) controlsPassed += 1;
    }

    // Una lección dada por hecha aporta su duración; una a medias aporta lo que
    // se estuvo en ella, topado. La diferencia entre respaldada y autodeclarada
    // NO está en cuánto suma —descontar de golpe las autodeclaradas dejaría a
    // cero el histórico de toda academia que ya esté operando— sino en que las
    // segundas viajan contadas aparte, y así se exportan.
    const credit = lesson.completed ? nominal : Math.min(watched, nominal);
    creditedSeconds += credit;
    if (lesson.completed && !isVerified) unverifiedSeconds += credit;

    firstAccess = earliest(firstAccess, lesson.firstAccessedAt);
    lastAccess = latest(lastAccess, lesson.lastAccessedAt);
  }

  // El tope global es innegociable: nunca se declaran más horas de las que la
  // acción formativa comunicó a Fundae, por mucho que el alumno acumulara.
  const cappedSeconds = totalSeconds > 0 ? Math.min(creditedSeconds, totalSeconds) : creditedSeconds;
  const scale = creditedSeconds > 0 ? cappedSeconds / creditedSeconds : 1;

  return {
    horasAsistidas: roundTwo(cappedSeconds / 3600),
    horasSinVerificar: roundTwo((unverifiedSeconds * scale) / 3600),
    horasDeclaradasPorProgreso: roundTwo((horasFormacion * clampPct(progressPercent)) / 100),
    segundosRegistrados: rawSeconds,
    leccionesTotales: lessons.length,
    leccionesIniciadas: started,
    leccionesCompletadas: completed,
    leccionesVerificadas: verified,
    actividadesTotales: activities,
    actividadesSuperadas: activitiesPassed,
    controlesTotales: controls,
    controlesSuperados: controlsPassed,
    pctHoras: totalSeconds > 0 ? roundTwo((cappedSeconds / totalSeconds) * 100) : 0,
    // Sin actividades en el itinerario el criterio no aplica; devolver 0 haría
    // que un curso legítimamente sin cuestionarios pareciera siempre suspenso.
    pctActividades: activities === 0 ? 100 : roundTwo((activitiesPassed / activities) * 100),
    // Mismo criterio: sin controles en el itinerario, el requisito no aplica.
    pctControles: controls === 0 ? 100 : roundTwo((controlsPassed / controls) * 100),
    primerAccesoAt: firstAccess,
    ultimoAccesoAt: lastAccess,
  };
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return b < a ? b : a;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}
