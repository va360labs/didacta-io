/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { RetentionUnknownVariableError, RetentionVariableNotAvailableError } from './errors.js';

/**
 * Variables que se pueden escribir en un mensaje automático.
 *
 * SEGURAS por construcción: es una lista cerrada, el valor es siempre texto
 * plano (el mensaje directo no interpreta HTML y el correo lo escapa al
 * pintarlo) y una variable que no está en la lista no se envía tal cual: se
 * rechaza al guardar. Así un «{nmbre}» con una errata no le llega a nadie.
 *
 * Cada variable tiene su nombre en los tres idiomas del aula y se aceptan los
 * tres en cualquier aula: quien copia una plantilla en inglés en un aula
 * española no se encuentra el mensaje roto.
 */

export type RetentionLocale = 'es' | 'en' | 'pt';

export const RETENTION_LOCALES: readonly RetentionLocale[] = ['es', 'en', 'pt'];

/** Normaliza el idioma del aula (`pt-BR` → `pt`, desconocido → `es`). */
export function retentionLocale(raw: unknown): RetentionLocale {
  if (typeof raw !== 'string') return 'es';
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return base === 'en' || base === 'pt' ? base : 'es';
}

export type RetentionTriggerName =
  | 'WELCOME'
  | 'DAYS_AFTER_JOIN'
  | 'INACTIVE'
  | 'COURSE_COMPLETED'
  | 'FIRST_POST'
  | 'LEVEL_UP'
  | 'ANNIVERSARY';

export const RETENTION_TRIGGERS: readonly RetentionTriggerName[] = [
  'WELCOME',
  'DAYS_AFTER_JOIN',
  'INACTIVE',
  'COURSE_COMPLETED',
  'FIRST_POST',
  'LEVEL_UP',
  'ANNIVERSARY',
];

export type RetentionVariableKey =
  | 'name'
  | 'academy'
  | 'course'
  | 'courseLink'
  | 'introLink'
  | 'communityLink'
  | 'academyLink'
  | 'level';

/** Cómo se escribe cada variable en cada idioma (sin las llaves). */
export const RETENTION_VARIABLE_TOKENS: Readonly<
  Record<RetentionVariableKey, Readonly<Record<RetentionLocale, string>>>
> = {
  name: { es: 'nombre', en: 'name', pt: 'nome' },
  academy: { es: 'academia', en: 'academy', pt: 'escola' },
  course: { es: 'curso', en: 'course', pt: 'curso' },
  courseLink: { es: 'enlace_curso', en: 'course_link', pt: 'link_curso' },
  introLink: { es: 'enlace_presentate', en: 'intro_link', pt: 'link_apresentacao' },
  communityLink: { es: 'enlace_comunidad', en: 'community_link', pt: 'link_comunidade' },
  academyLink: { es: 'enlace_academia', en: 'academy_link', pt: 'link_escola' },
  level: { es: 'nivel', en: 'level', pt: 'nivel' },
};

export const RETENTION_VARIABLE_KEYS = Object.keys(
  RETENTION_VARIABLE_TOKENS,
) as RetentionVariableKey[];

/** `{nível}` y `{Nombre}` valen igual que `{nivel}` y `{nombre}`. */
function normalizeToken(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

const ALIAS_TO_KEY: ReadonlyMap<string, RetentionVariableKey> = new Map(
  RETENTION_VARIABLE_KEYS.flatMap((key) =>
    RETENTION_LOCALES.map((l) => [RETENTION_VARIABLE_TOKENS[key][l], key] as const),
  ),
);

/** Una palabra entre llaves, con letras o guion bajo: `{nombre}`, `{course_link}`. */
const TOKEN_RE = /\{\s*([\p{L}_]+)\s*\}/gu;

/** Qué variables tienen valor en cada tipo de mensaje. */
export function variablesFor(trigger: RetentionTriggerName): RetentionVariableKey[] {
  return RETENTION_VARIABLE_KEYS.filter((k) => k !== 'level' || trigger === 'LEVEL_UP');
}

export interface FoundVariables {
  known: Array<{ raw: string; key: RetentionVariableKey }>;
  unknown: string[];
}

export function findVariables(text: string): FoundVariables {
  const known: FoundVariables['known'] = [];
  const unknown: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[1] ?? '';
    const key = ALIAS_TO_KEY.get(normalizeToken(raw));
    if (key) known.push({ raw, key });
    else if (!unknown.includes(raw)) unknown.push(raw);
  }
  return { known, unknown };
}

/** Lanza si el texto usa una variable que no existe o que este mensaje no tiene. */
export function assertVariables(text: string, trigger: RetentionTriggerName): void {
  const { known, unknown } = findVariables(text);
  if (unknown.length > 0) throw new RetentionUnknownVariableError(unknown);
  const allowed = new Set(variablesFor(trigger));
  const notAvailable = known.find((v) => !allowed.has(v.key));
  if (notAvailable) throw new RetentionVariableNotAvailableError(notAvailable.raw);
}

/**
 * Sustituye las variables por su valor. Una variable SIN valor (`undefined`) se
 * deja escrita tal cual: solo pasa en la vista previa cuando el dato no existe
 * todavía (un aula sin cursos), y enseñar `{curso}` es más honesto que
 * inventarse uno. Al enviar, el servicio rellena todas.
 */
export function renderText(
  text: string,
  values: Partial<Record<RetentionVariableKey, string>>,
): string {
  return text.replace(TOKEN_RE, (whole, raw: string) => {
    const key = ALIAS_TO_KEY.get(normalizeToken(raw));
    if (!key) return whole;
    const value = values[key];
    return value === undefined ? whole : value;
  });
}

/**
 * Nombre de pila para el saludo. Sin nombre en el perfil, la parte del correo
 * antes de la arroba, capitalizada (`ana.garcia@…` → «Ana»): un «¡Hola, !» con
 * el hueco vacío es peor que un saludo un poco genérico.
 */
export function firstNameOf(name: string | null | undefined, email: string): string {
  const fromName = (name ?? '').trim().split(/\s+/)[0];
  if (fromName) return fromName;
  const local = (email.split('@')[0] ?? '').split(/[._+-]/)[0] ?? '';
  if (!local) return '';
  return local.charAt(0).toUpperCase() + local.slice(1);
}
