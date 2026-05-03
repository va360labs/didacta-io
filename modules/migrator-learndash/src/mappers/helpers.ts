import type { LdCourse, LdLesson, LdTopic, LdQuiz, LdQuestion, WpUser } from '../connector/index.js';

export function externalId(sourceId: string | number): string {
  return `learndash:${sourceId}`;
}

export function unwrapTitle(title: { rendered: string } | string | undefined): string {
  if (typeof title === 'string') return title;
  if (title && typeof title === 'object' && typeof title.rendered === 'string') return title.rendered;
  return '';
}

export function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

/**
 * LearnDash y WordPress emiten campos en `meta`, `_meta` o el root
 * de forma inconsistente entre versiones. Esta función busca un campo
 * en varios lugares en orden de preferencia.
 */
export function readField<T = unknown>(obj: Record<string, unknown> | undefined, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (k in obj) return obj[k] as T;
  }
  // Buscar dentro de meta si existe
  const meta = obj['meta'] as Record<string, unknown> | undefined;
  if (meta) {
    for (const k of keys) {
      if (k in meta) return meta[k] as T;
    }
  }
  return undefined;
}

/**
 * Mapeo de status WordPress (publish, draft, private, future, pending,
 * trash) a nuestro status canónico (draft|published|archived).
 */
export function mapWpStatus(wpStatus: string | undefined): 'draft' | 'published' | 'archived' {
  if (wpStatus === 'publish') return 'published';
  if (wpStatus === 'trash') return 'archived';
  return 'draft';
}

/**
 * Mapeo del tipo de question LearnDash al canónico Didacta.
 * LearnDash: single, multiple, free_answer, sort_answer, matrix_sort_answer,
 * cloze_answer, essay, assessment_answer.
 */
export function mapLdQuestionType(ldType: string | undefined): {
  type:
    | 'single'
    | 'multiple'
    | 'free_text'
    | 'sort'
    | 'matrix'
    | 'cloze'
    | 'essay'
    | 'assessment';
  warning?: string;
} {
  switch (ldType) {
    case 'single':
      return { type: 'single' };
    case 'multiple':
      return { type: 'multiple' };
    case 'free_answer':
      return { type: 'free_text' };
    case 'sort_answer':
      return { type: 'sort' };
    case 'matrix_sort_answer':
      return { type: 'matrix' };
    case 'cloze_answer':
      return { type: 'cloze' };
    case 'essay':
      return { type: 'essay' };
    case 'assessment_answer':
      return { type: 'assessment' };
    default:
      return { type: 'single', warning: `Tipo de pregunta desconocido '${ldType ?? '<vacío>'}'; tratado como single` };
  }
}

/** Convierte un email vacío/inválido a undefined. */
export function safeEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  // Validación mínima — el connector ya recibe lo que el origen le da.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Roles WP/LearnDash → canónico Didacta.
 * 'subscriber', 'student' → 'student'
 * 'group_leader' → 'group_leader'
 * 'administrator' → 'admin' (rara vez se migra; se filtra antes)
 * 'editor', 'author' → 'instructor' (mejor aproximación)
 */
export function mapWpRoles(roles: string[] | undefined): string[] {
  if (!roles || roles.length === 0) return ['student'];
  const out = new Set<string>();
  for (const r of roles) {
    if (r === 'subscriber' || r === 'student' || r === 'customer') out.add('student');
    else if (r === 'group_leader') out.add('group_leader');
    else if (r === 'administrator') out.add('admin');
    else if (r === 'editor' || r === 'author' || r === 'wdm_instructor') out.add('instructor');
    // otros roles se ignoran; el destino no los usa
  }
  if (out.size === 0) out.add('student');
  return Array.from(out);
}

/** Type guards utilitarios. */
export function isLdCourse(v: unknown): v is LdCourse {
  return typeof v === 'object' && v !== null && 'id' in (v as Record<string, unknown>);
}
export function isLdLesson(v: unknown): v is LdLesson {
  return typeof v === 'object' && v !== null && 'id' in (v as Record<string, unknown>);
}
export function isLdTopic(v: unknown): v is LdTopic {
  return typeof v === 'object' && v !== null && 'id' in (v as Record<string, unknown>);
}
export function isLdQuiz(v: unknown): v is LdQuiz {
  return typeof v === 'object' && v !== null && 'id' in (v as Record<string, unknown>);
}
export function isLdQuestion(v: unknown): v is LdQuestion {
  return typeof v === 'object' && v !== null && 'id' in (v as Record<string, unknown>);
}
export function isWpUser(v: unknown): v is WpUser {
  return typeof v === 'object' && v !== null && 'id' in (v as Record<string, unknown>);
}
