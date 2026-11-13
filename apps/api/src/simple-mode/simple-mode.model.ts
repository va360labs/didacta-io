/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

/**
 * Tipos, textos y funciones PURAS del modo sencillo. Separados del servicio
 * para poder probarlos sin base de datos.
 */

export type SimpleLocale = 'es' | 'en';

/** Los seis pasos de «Empieza aquí», en orden. */
export const STEP_IDS = ['academy', 'course', 'price', 'payments', 'publish', 'invite'] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Lo que el creador quiere vender y a qué precio (antes y después de publicar). */
export interface OfferIntent {
  kind: 'course' | 'membership';
  courseId: string | null;
  planId: string | null;
  /** En la unidad mínima de la moneda (céntimos). */
  amountCents: number;
  /** ISO 4217 en minúsculas. */
  currency: string;
}

export function emptyOfferIntent(): OfferIntent {
  return { kind: 'course', courseId: null, planId: null, amountCents: 0, currency: 'eur' };
}

export interface StartHereView {
  academyName: string;
  /** El alta en 3 preguntas ya se hizo. */
  quickStartDone: boolean;
  offer: (OfferIntent & { courseTitle: string | null; courseSlug: string | null }) | null;
  /** Curso al que lleva el paso 2 (el de la oferta, o el primero del aula). */
  firstCourseId: string | null;
  steps: Array<{ id: StepId; done: boolean }>;
  /** Ruta del enlace de venta (`/catalogo/<slug>` o `/unete`) cuando ya está publicado. */
  salePath: string | null;
  sales: { count: number; firstSaleAt: string | null };
  /** Personas del aula que no son del equipo (invitadas o ya dentro). */
  students: number;
  nextLive: { id: string; topic: string; startTime: string } | null;
  /** Dónde se conectan los cobros: la tarjeta de la plataforma o las claves propias. */
  paymentsSetupPath: string;
}

/** Monedas con claves propias de Stripe (Community): las de siempre. */
export const OWN_KEYS_CURRENCIES: readonly string[] = ['eur', 'usd', 'gbp', 'mxn'];
/**
 * Monedas con cobros de plataforma, si la política del aula no se pudo leer.
 * Debe coincidir con `PLATFORM_PRICE_CURRENCIES` de `mod.payouts`.
 */
export const PLATFORM_CURRENCIES: readonly string[] = [
  'eur',
  'gbp',
  'chf',
  'sek',
  'dkk',
  'nok',
  'pln',
  'czk',
  'huf',
  'ron',
  'usd',
  'cad',
];

// ── Peticiones ─────────────────────────────────────────────────────────────

const currencySchema = z
  .string()
  .regex(/^[a-zA-Z]{3}$/)
  .transform((c) => c.toLowerCase());

export const quickStartSchema = z.object({
  academyName: z.string().trim().min(1).max(120),
  offer: z.enum(['course', 'membership']),
  /** Nombre del curso o de la membresía. Vacío = el de la academia. */
  title: z.string().trim().max(160).optional(),
  amountCents: z.number().int().positive().max(100_000_000),
  currency: currencySchema,
  locale: z.enum(['es', 'en']).default('es'),
});
export type QuickStartInput = z.infer<typeof quickStartSchema>;

export const priceSchema = z.object({
  amountCents: z.number().int().positive().max(100_000_000),
  currency: currencySchema,
});

export const toggleSchema = z.object({ enabled: z.boolean() });

// ── Errores ────────────────────────────────────────────────────────────────

export class SimpleModeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SimpleModeError';
  }
}

// ── Utilidades puras ───────────────────────────────────────────────────────

/**
 * Enlace del curso a partir de su título: sin acentos, en minúsculas y con
 * guiones. El creador nunca lo ve ni lo escribe (era el campo «Slug» con
 * «kebab-case» del formulario completo).
 */
export function toCourseSlug(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'curso';
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * ¿Tiene la lección algo que ver? Una lección recién creada nace con
 * `content: {}`: todavía no se puede vender.
 */
export function lessonHasContent(type: string, content: unknown): boolean {
  if (!content || typeof content !== 'object') return false;
  const c = content as Record<string, unknown>;
  switch (type) {
    case 'VIDEO':
      return nonEmpty(c.videoUrl);
    case 'TEXT':
      return nonEmpty(c.text) || nonEmpty(c.html);
    case 'HTML':
      return nonEmpty(c.html);
    case 'PDF':
      return nonEmpty(c.pdfUrl);
    case 'QUIZ':
      return nonEmpty(c.quizId);
    case 'SCORM':
      return Object.keys(c).length > 0;
    default:
      return false;
  }
}

// ── Textos que se guardan en filas reales (idioma del creador) ─────────────

interface SpaceSeed {
  slug: string;
  title: string;
  description: string;
  icon: string;
  sortOrder: number;
}

interface SimpleTexts {
  firstModule: string;
  /** Idioma del curso (`mod.courses`), para el reproductor y el catálogo. */
  courseLanguage: string;
  spaces: SpaceSeed[];
  welcomeTitle: (academy: string) => string;
  welcomeBody: (academy: string) => string;
}

const TEXTS: Record<SimpleLocale, SimpleTexts> = {
  es: {
    firstModule: 'Lecciones',
    courseLanguage: 'es-ES',
    spaces: [
      {
        slug: 'general',
        title: 'General',
        description: 'Conversaciones abiertas para toda la comunidad.',
        icon: '#',
        sortOrder: 1,
      },
      {
        slug: 'anuncios',
        title: 'Anuncios',
        description: 'Novedades y avisos importantes.',
        icon: 'megaphone',
        sortOrder: 2,
      },
      {
        slug: 'preguntas',
        title: 'Preguntas y dudas',
        description: 'Pregunta lo que necesites.',
        icon: 'help',
        sortOrder: 3,
      },
    ],
    welcomeTitle: (a) => `Te doy la bienvenida a ${a}`,
    welcomeBody: (a) =>
      `Este es el espacio de la comunidad de ${a}. Aquí publicaré novedades y podrás preguntar lo que necesites.\n\nPara empezar, preséntate en un comentario: quién eres y qué te gustaría conseguir.`,
  },
  en: {
    firstModule: 'Lessons',
    courseLanguage: 'en-US',
    spaces: [
      {
        slug: 'general',
        title: 'General',
        description: 'Open conversations for the whole community.',
        icon: '#',
        sortOrder: 1,
      },
      {
        slug: 'anuncios',
        title: 'Announcements',
        description: 'News and important updates.',
        icon: 'megaphone',
        sortOrder: 2,
      },
      {
        slug: 'preguntas',
        title: 'Questions',
        description: 'Ask anything you need.',
        icon: 'help',
        sortOrder: 3,
      },
    ],
    welcomeTitle: (a) => `Welcome to ${a}`,
    welcomeBody: (a) =>
      `This is the community space for ${a}. I will post updates here, and you can ask anything you need.\n\nTo get started, introduce yourself in a comment: who you are and what you would like to achieve.`,
  },
};

export function textsFor(locale: SimpleLocale): SimpleTexts {
  return TEXTS[locale] ?? TEXTS.es;
}
