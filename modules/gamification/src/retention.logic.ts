/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Reglas puras de la retención (sin BD): el día local de una persona, la racha,
 * el número de nivel, si un cierre está abierto y el texto de una celebración.
 * Viven aparte del service para poder probarlas una a una sin montar Prisma.
 */

/** Día natural `YYYY-MM-DD` de un instante en una zona horaria IANA. */
export function localDay(at: Date, timeZone: string): string {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    // Zona mal escrita en el perfil: mejor UTC que perder el día de actividad.
    tz = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `YYYY-MM-DD` → milisegundos del día a las 00:00 UTC (aritmética de calendario). */
export function dayToUtcMs(day: string): number {
  const [y, m, d] = day.split('-').map((n) => Number(n));
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

export function utcMsToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  return utcMsToDay(dayToUtcMs(day) + delta * 86_400_000);
}

/** Lunes de la semana del día (las semanas van de lunes a domingo). */
export function weekStart(day: string): string {
  const ms = dayToUtcMs(day);
  const weekday = new Date(ms).getUTCDay(); // 0 = domingo
  const back = (weekday + 6) % 7;
  return utcMsToDay(ms - back * 86_400_000);
}

export interface StreakCounts {
  /** Días seguidos que acaban en el último día activo. */
  runDays: number;
  bestDays: number;
  /** Semanas seguidas que acaban en la última semana activa. */
  runWeeks: number;
  bestWeeks: number;
  lastDay: string | null;
}

/**
 * Racha a partir de los días con actividad (en cualquier orden, con o sin
 * repetidos). No decide si la racha «sigue viva» hoy: eso depende de la fecha
 * de consulta y lo hace `liveStreak`.
 */
export function computeStreak(days: readonly string[]): StreakCounts {
  const unique = [...new Set(days)].sort();
  if (unique.length === 0) {
    return { runDays: 0, bestDays: 0, runWeeks: 0, bestWeeks: 0, lastDay: null };
  }
  const dayRuns = runs(unique, 1);
  const weeks = [...new Set(unique.map(weekStart))].sort();
  const weekRuns = runs(weeks, 7);
  return {
    runDays: dayRuns.last,
    bestDays: dayRuns.best,
    runWeeks: weekRuns.last,
    bestWeeks: weekRuns.best,
    lastDay: unique[unique.length - 1]!,
  };
}

function runs(sorted: readonly string[], stepDays: number): { last: number; best: number } {
  let best = 0;
  let current = 0;
  let prev: number | null = null;
  for (const d of sorted) {
    const ms = dayToUtcMs(d);
    current = prev !== null && ms - prev === stepDays * 86_400_000 ? current + 1 : 1;
    best = Math.max(best, current);
    prev = ms;
  }
  return { last: current, best };
}

export interface LiveStreak {
  currentDays: number;
  currentWeeks: number;
  activeToday: boolean;
}

/**
 * La racha tal y como se enseña HOY. Reglas claras y sin castigo:
 *  - un día sin actividad todavía no rompe nada: la racha sigue viva hasta que
 *    pasa un día ENTERO sin actividad (hoy cuenta hasta medianoche);
 *  - la racha semanal solo se rompe cuando pasa una semana entera sin actividad.
 */
export function liveStreak(
  stored: { runDays: number; runWeeks: number; lastDay: string | null },
  today: string,
): LiveStreak {
  if (!stored.lastDay) return { currentDays: 0, currentWeeks: 0, activeToday: false };
  const activeToday = stored.lastDay === today;
  const dayAlive = stored.lastDay >= addDays(today, -1);
  const weekAlive = weekStart(stored.lastDay) >= addDays(weekStart(today), -7);
  return {
    currentDays: dayAlive ? stored.runDays : 0,
    currentWeeks: weekAlive ? stored.runWeeks : 0,
    activeToday,
  };
}

export interface LevelLike {
  id: string;
  key: string;
  name: string;
  minPoints: number;
}

export interface NumberedLevel extends LevelLike {
  /** 1 = el nivel con menos puntos. Es el «nivel N» que ve el alumno. */
  number: number;
}

export function numberLevels(levels: readonly LevelLike[]): NumberedLevel[] {
  return [...levels]
    .sort((a, b) => a.minPoints - b.minPoints)
    .map((l, i) => ({ ...l, number: i + 1 }));
}

/**
 * ¿Ha llegado la persona a este nivel? Por puntos de por vida O por el nivel
 * que ya tenía guardado: el nivel alcanzado no se retira aunque una revocación
 * le baje los puntos, así que tampoco se le vuelve a cerrar lo que ya abrió.
 */
export function hasReached(
  level: { minPoints: number },
  progress: { lifetimePoints: number; currentLevelMinPoints: number | null },
): boolean {
  if (progress.lifetimePoints >= level.minPoints) return true;
  return (
    progress.currentLevelMinPoints !== null && progress.currentLevelMinPoints >= level.minPoints
  );
}

export function pointsMissing(
  level: { minPoints: number },
  progress: { lifetimePoints: number; currentLevelMinPoints: number | null },
): number {
  if (hasReached(level, progress)) return 0;
  return Math.max(0, level.minPoints - progress.lifetimePoints);
}

// ── Celebraciones ────────────────────────────────────────────────────────────

export type CelebrationKind = 'course' | 'intro' | 'anniversary' | 'level';
export const CELEBRATION_KINDS: readonly CelebrationKind[] = [
  'course',
  'intro',
  'anniversary',
  'level',
];

export interface CelebrationEntry {
  userId: string;
  name: string;
  /** Curso terminado, nivel alcanzado o años cumplidos (como texto). */
  detail?: string | null;
}

export type CelebrationLocale = 'es' | 'en' | 'pt';

/** Marca invisible para reconocer el post (y no puntuarlo ni celebrarlo). */
export const CELEBRATION_MARKER = '<!--didacta-celebracion-->';

/** Tope de nombres con detalle en un post agrupado; el resto, «y N más». */
const LIST_MAX = 12;

/**
 * El cuerpo se pinta con el Markdown seguro de la comunidad, que no tiene
 * escapes: se QUITAN los caracteres que abrirían formato, enlace o mención
 * (una «@» en un nombre mencionaría, y avisaría, a otra persona).
 */
export function escapeMd(text: string): string {
  return (
    text
      .replace(/[\\[\]*_`#<>|@]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || '—'
  );
}

function person(e: CelebrationEntry): string {
  return `**${escapeMd(e.name)}**`;
}

interface Copy {
  one: (e: CelebrationEntry) => { title: string; body: string };
  manyTitle: (n: number) => string;
  manyIntro: string;
  line: (e: CelebrationEntry) => string;
  more: (n: number) => string;
  outro: string;
}

function years(detail: string | null | undefined): number {
  const n = Number(detail);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const COPY: Record<CelebrationLocale, Record<CelebrationKind, Copy>> = {
  es: {
    course: {
      one: (e) => ({
        title: `🎓 ¡${e.name} ha terminado «${e.detail ?? ''}»!`,
        body: `${person(e)} acaba de terminar el curso «${escapeMd(e.detail ?? '')}». ¡Enhorabuena! Déjale un comentario.`,
      }),
      manyTitle: (n) => `🎓 Hoy han terminado un curso ${n} personas`,
      manyIntro: 'Enhorabuena a quienes han terminado un curso hoy:',
      line: (e) => `- ${person(e)} — «${escapeMd(e.detail ?? '')}»`,
      more: (n) => `- y ${n} más`,
      outro: '¡A por el siguiente!',
    },
    intro: {
      one: (e) => ({
        title: `👋 Te damos la bienvenida, ${e.name}`,
        body: `${person(e)} acaba de presentarse en la comunidad. ¡Pásate a saludar!`,
      }),
      manyTitle: (n) => `👋 Hoy se han presentado ${n} personas`,
      manyIntro: 'Damos la bienvenida a quienes se han presentado hoy:',
      line: (e) => `- ${person(e)}`,
      more: (n) => `- y ${n} más`,
      outro: '¡Pasaos a saludar!',
    },
    anniversary: {
      one: (e) => {
        const n = years(e.detail);
        const anios = n === 1 ? '1 año' : `${n} años`;
        return {
          title: `🎂 ${e.name} cumple ${anios} en la comunidad`,
          body: `Hoy hace ${anios} que ${person(e)} se unió a la comunidad. ¡Gracias por estar aquí!`,
        };
      },
      manyTitle: (n) => `🎂 Hoy celebran su aniversario ${n} personas`,
      manyIntro: 'Hoy cumplen años en la comunidad:',
      line: (e) => {
        const n = years(e.detail);
        return `- ${person(e)} — ${n === 1 ? '1 año' : `${n} años`}`;
      },
      more: (n) => `- y ${n} más`,
      outro: '¡Gracias por estar aquí!',
    },
    level: {
      one: (e) => ({
        title: `⭐ ${e.name} ha subido al nivel ${e.detail ?? ''}`,
        body: `${person(e)} acaba de llegar al nivel ${escapeMd(e.detail ?? '')}. ¡Enhorabuena!`,
      }),
      manyTitle: (n) => `⭐ Hoy han subido de nivel ${n} personas`,
      manyIntro: 'Enhorabuena a quienes han subido de nivel hoy:',
      line: (e) => `- ${person(e)} — ${escapeMd(e.detail ?? '')}`,
      more: (n) => `- y ${n} más`,
      outro: '¡Seguid así!',
    },
  },
  en: {
    course: {
      one: (e) => ({
        title: `🎓 ${e.name} finished "${e.detail ?? ''}"!`,
        body: `${person(e)} has just finished the course "${escapeMd(e.detail ?? '')}". Congratulations! Leave them a comment.`,
      }),
      manyTitle: (n) => `🎓 ${n} people finished a course today`,
      manyIntro: 'Congratulations to everyone who finished a course today:',
      line: (e) => `- ${person(e)} — "${escapeMd(e.detail ?? '')}"`,
      more: (n) => `- and ${n} more`,
      outro: 'On to the next one!',
    },
    intro: {
      one: (e) => ({
        title: `👋 Welcome, ${e.name}`,
        body: `${person(e)} has just introduced themselves to the community. Stop by and say hi!`,
      }),
      manyTitle: (n) => `👋 ${n} people introduced themselves today`,
      manyIntro: 'A warm welcome to everyone who introduced themselves today:',
      line: (e) => `- ${person(e)}`,
      more: (n) => `- and ${n} more`,
      outro: 'Stop by and say hi!',
    },
    anniversary: {
      one: (e) => {
        const n = years(e.detail);
        const label = n === 1 ? '1 year' : `${n} years`;
        return {
          title: `🎂 ${e.name} celebrates ${label} in the community`,
          body: `${person(e)} joined the community ${label} ago today. Thank you for being here!`,
        };
      },
      manyTitle: (n) => `🎂 ${n} people celebrate their anniversary today`,
      manyIntro: 'Celebrating their community anniversary today:',
      line: (e) => {
        const n = years(e.detail);
        return `- ${person(e)} — ${n === 1 ? '1 year' : `${n} years`}`;
      },
      more: (n) => `- and ${n} more`,
      outro: 'Thank you for being here!',
    },
    level: {
      one: (e) => ({
        title: `⭐ ${e.name} reached level ${e.detail ?? ''}`,
        body: `${person(e)} has just reached level ${escapeMd(e.detail ?? '')}. Congratulations!`,
      }),
      manyTitle: (n) => `⭐ ${n} people levelled up today`,
      manyIntro: 'Congratulations to everyone who levelled up today:',
      line: (e) => `- ${person(e)} — ${escapeMd(e.detail ?? '')}`,
      more: (n) => `- and ${n} more`,
      outro: 'Keep it up!',
    },
  },
  pt: {
    course: {
      one: (e) => ({
        title: `🎓 ${e.name} concluiu "${e.detail ?? ''}"!`,
        body: `${person(e)} acaba de concluir o curso "${escapeMd(e.detail ?? '')}". Parabéns! Deixe um comentário.`,
      }),
      manyTitle: (n) => `🎓 Hoje ${n} pessoas concluíram um curso`,
      manyIntro: 'Parabéns a quem concluiu um curso hoje:',
      line: (e) => `- ${person(e)} — "${escapeMd(e.detail ?? '')}"`,
      more: (n) => `- e mais ${n}`,
      outro: 'Rumo ao próximo!',
    },
    intro: {
      one: (e) => ({
        title: `👋 Boas-vindas, ${e.name}`,
        body: `${person(e)} acaba de se apresentar na comunidade. Passe para dar um oi!`,
      }),
      manyTitle: (n) => `👋 Hoje ${n} pessoas se apresentaram`,
      manyIntro: 'Damos as boas-vindas a quem se apresentou hoje:',
      line: (e) => `- ${person(e)}`,
      more: (n) => `- e mais ${n}`,
      outro: 'Passem para dar um oi!',
    },
    anniversary: {
      one: (e) => {
        const n = years(e.detail);
        const label = n === 1 ? '1 ano' : `${n} anos`;
        return {
          title: `🎂 ${e.name} completa ${label} na comunidade`,
          body: `Hoje faz ${label} que ${person(e)} entrou na comunidade. Obrigado por estar aqui!`,
        };
      },
      manyTitle: (n) => `🎂 Hoje ${n} pessoas comemoram aniversário na comunidade`,
      manyIntro: 'Hoje fazem aniversário na comunidade:',
      line: (e) => {
        const n = years(e.detail);
        return `- ${person(e)} — ${n === 1 ? '1 ano' : `${n} anos`}`;
      },
      more: (n) => `- e mais ${n}`,
      outro: 'Obrigado por estarem aqui!',
    },
    level: {
      one: (e) => ({
        title: `⭐ ${e.name} subiu para o nível ${e.detail ?? ''}`,
        body: `${person(e)} acaba de chegar ao nível ${escapeMd(e.detail ?? '')}. Parabéns!`,
      }),
      manyTitle: (n) => `⭐ Hoje ${n} pessoas subiram de nível`,
      manyIntro: 'Parabéns a quem subiu de nível hoje:',
      line: (e) => `- ${person(e)} — ${escapeMd(e.detail ?? '')}`,
      more: (n) => `- e mais ${n}`,
      outro: 'Continuem assim!',
    },
  },
};

/** Normaliza el idioma del aula (`es-ES`, `pt-BR`, `en`…) a uno de los tres. */
export function celebrationLocale(locale: string | null | undefined): CelebrationLocale {
  const base = (locale ?? 'es').slice(0, 2).toLowerCase();
  return base === 'en' || base === 'pt' ? base : 'es';
}

/**
 * Texto del post de una celebración. Con una sola persona, un post personal;
 * con varias el mismo día, UN post que las nombra a todas (sin spam).
 */
export function renderCelebration(
  kind: CelebrationKind,
  entries: readonly CelebrationEntry[],
  locale: CelebrationLocale,
): { title: string; body: string } {
  const copy = COPY[locale][kind];
  const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 197)}…` : s);
  if (entries.length === 1) {
    const e = entries[0]!;
    // El título no pasa por Markdown (el cuerpo sí, y allí se limpia aparte):
    // aquí solo se aplanan los saltos de línea, que partirían la cabecera.
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    const one = copy.one({
      ...e,
      name: flat(e.name),
      detail: e.detail ? flat(e.detail) : e.detail,
    });
    return { title: clip(one.title), body: `${one.body}\n\n${CELEBRATION_MARKER}` };
  }
  const shown = entries.slice(0, LIST_MAX);
  const lines = shown.map((e) => copy.line(e));
  if (entries.length > LIST_MAX) lines.push(copy.more(entries.length - LIST_MAX));
  return {
    title: clip(copy.manyTitle(entries.length)),
    body: `${copy.manyIntro}\n\n${lines.join('\n')}\n\n${copy.outro}\n\n${CELEBRATION_MARKER}`,
  };
}

export function isCelebrationBody(body: string | null | undefined): boolean {
  return !!body && body.includes(CELEBRATION_MARKER);
}

// ── Nombres por defecto de las insignias ─────────────────────────────────────

/**
 * Nombre de una insignia que el creador no ha renombrado, en el idioma del aula.
 * Lo usa el aviso por correo (la interfaz tiene su propio catálogo).
 */
export function defaultBadgeName(
  kind: string,
  threshold: number,
  locale: CelebrationLocale,
): string {
  const names: Record<CelebrationLocale, Record<string, string>> = {
    es: {
      first_post: 'Primera publicación',
      first_comment: 'Primer comentario',
      first_course: 'Primer curso terminado',
      streak_days: `Racha de ${threshold} días`,
      level: `Nivel ${threshold}`,
    },
    en: {
      first_post: 'First post',
      first_comment: 'First comment',
      first_course: 'First course completed',
      streak_days: `${threshold}-day streak`,
      level: `Level ${threshold}`,
    },
    pt: {
      first_post: 'Primeira publicação',
      first_comment: 'Primeiro comentário',
      first_course: 'Primeiro curso concluído',
      streak_days: `Sequência de ${threshold} dias`,
      level: `Nível ${threshold}`,
    },
  };
  return names[locale][kind] ?? kind;
}
