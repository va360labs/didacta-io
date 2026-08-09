/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Formateo de las variables de notificación EN EL HUB, en el idioma del
 * destinatario.
 *
 * ── El bug (MUST-FIX 37) ─────────────────────────────────────────────────────
 *
 * Los emisores (bridges y workers) componían el dato antes de llamar al hub:
 *
 *   variables: { result: passed ? 'aprobado' : 'no aprobado' }
 *   variables: { startsAt: new Intl.DateTimeFormat('es-ES', …).format(d) }
 *   variables: { amount: new Intl.NumberFormat('es-ES', …).format(c / 100) }
 *
 * La PLANTILLA sí se traducía —el catálogo tiene su gemela inglesa— pero el
 * dato ya venía convertido en texto español, así que un destinatario `en-US`
 * recibía «Result: 82% (aprobado)» y «starts 14 de marzo de 2026, 18:00».
 * Ninguna traducción del catálogo podía alcanzarlo: no era copy de plantilla,
 * era un valor.
 *
 * ── Por qué se arregla AQUÍ y no en el emisor ────────────────────────────────
 *
 * El emisor NO conoce el idioma. Un evento de cancelación de clase se manda a
 * los N inscritos, cada uno con su `user.locale`, y el hub resuelve ese locale
 * por destinatario justo antes de renderizar. Pasarle el idioma al emisor
 * significaría renderizar N veces en el emisor: es mover el problema.
 *
 * Así que el emisor entrega el dato CRUDO (un ISO, unos céntimos, una clave de
 * término) envuelto en un `NotificationValue` y este módulo lo convierte en
 * texto con el locale que el hub ya tiene.
 *
 * ── Byte a byte en español ───────────────────────────────────────────────────
 *
 * Las opciones de `Intl` y los textos españoles son EXACTAMENTE los que había
 * cableados en cada emisor, y el locale español es `HUB_DEFAULT_LOCALE` vía
 * `emailDateLocale`. Un destinatario `es-ES` recibe hoy lo mismo que ayer; hay
 * test por cada formato y por cada término.
 */

import type { NotificationTerm, NotificationValue } from '@didacta/core-kernel';
import {
  emailDateLocale,
  HUB_TEMPLATE_LANGS,
  interpolate,
  toHubTemplateLang,
  type HubTemplateLang,
} from './email-template-catalog';

/**
 * ¿Es este valor un descriptor que el hub tiene que formatear?
 *
 * La marca es una propiedad propia (`hubValue`) y no un `instanceof` porque
 * los emisores construyen literales de objeto y porque el descriptor tiene que
 * poder cruzar el límite de paquete (`modules/**` → host) sin compartir clase.
 */
export function isNotificationValue(value: unknown): value is NotificationValue {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { hubValue?: unknown }).hubValue;
  return kind === 'date' || kind === 'money' || kind === 'term';
}

/**
 * Frases con traducción propia que un emisor entrega como CLAVE.
 *
 * Los textos españoles son literalmente los que estaban incrustados en cada
 * emisor: se movieron de sitio, no se reescribieron. `satisfies` obliga a que
 * los dos idiomas cubran TODOS los términos de la unión — un término nuevo sin
 * inglés no compila, que es justo lo que impide que se cuele un email a medias.
 */
export const HUB_TERMS = {
  es: {
    // apps/api/src/modules/notifications/notifications.bridge.ts
    'quiz.result.passed': 'aprobado',
    'quiz.result.not_passed': 'no aprobado',
    // apps/api/src/modules/gamification/gamification-notifications.bridge.ts
    'gamification.perk.approved':
      'Hemos aprobado tu solicitud de "{{perkTitle}}". Te escribimos para cuadrarlo.',
    'gamification.perk.done':
      'Tu solicitud de "{{perkTitle}}" ya está hecha. ¡Esperamos que te haya servido!',
    'gamification.perk.rejected':
      'Esta vez no hemos podido atender tu solicitud de "{{perkTitle}}".',
    'gamification.staff.challenge_submitted': 'Nueva entrega de reto pendiente de revisar.',
    'gamification.staff.perk_requested': 'Alguien ha pedido un beneficio de su nivel.',
    // modules/community/src/community.service.ts
    'community.actor.unknown': 'Alguien',
    // apps/api/src/modules/lesson-unlock-notifier.worker.ts
    'learning.course.unknown': 'tu curso',
  },
  en: {
    'quiz.result.passed': 'passed',
    'quiz.result.not_passed': 'not passed',
    'gamification.perk.approved':
      'We have approved your request for "{{perkTitle}}". We will write to you to arrange it.',
    'gamification.perk.done':
      'Your request for "{{perkTitle}}" is done. We hope it was useful to you!',
    'gamification.perk.rejected': 'This time we could not fulfil your request for "{{perkTitle}}".',
    'gamification.staff.challenge_submitted': 'A new challenge submission is waiting for review.',
    'gamification.staff.perk_requested': 'Someone has requested a perk from their level.',
    'community.actor.unknown': 'Someone',
    'learning.course.unknown': 'your course',
  },
} as const satisfies Record<HubTemplateLang, Record<NotificationTerm, string>>;

/** Un término en el idioma del destinatario, ya interpolado con sus `vars`. */
export function resolveHubTerm(
  term: NotificationTerm,
  locale: string | null | undefined,
  vars?: Readonly<Record<string, string>>,
): string {
  const text = HUB_TERMS[toHubTemplateLang(locale)][term];
  return vars ? interpolate(text, vars) : text;
}

/**
 * Opciones de `Intl.DateTimeFormat` por formato. Son las MISMAS que estaban
 * cableadas en cada emisor, con el mismo nombre de sitio de uso:
 *
 *  · `datetime`         → confirmación y cancelación de clase en directo.
 *  · `weekday_datetime` → recordatorio 2 h antes (lleva el día de la semana).
 *
 * `timeZone` NO va aquí: lo pone cada notificación (la zona del formador).
 */
const DATE_FORMATS: Record<
  Extract<NotificationValue, { hubValue: 'date' }>['format'],
  Intl.DateTimeFormatOptions
> = {
  datetime: {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
  weekday_datetime: {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  },
};

/**
 * CAMINO DEGRADADO NOMBRADO de las fechas: un ISO que `Date` no sabe leer, o
 * una `timeZone` que `Intl` rechaza, cae al ISO 8601 en UTC.
 *
 * Es el MISMO fallback que ya tenían los dos emisores (`catch { return
 * date.toISOString() }`), y se conserva por la misma razón: una fecha fea es
 * peor que ninguna notificación, no al revés — el alumno tiene que enterarse de
 * que su clase se ha cancelado aunque la hora salga sin formatear.
 */
export const HUB_DATE_FALLBACK_FORMAT = 'ISO-8601 UTC';

function formatDate(
  value: Extract<NotificationValue, { hubValue: 'date' }>,
  locale: string | null | undefined,
): string {
  const date = new Date(value.iso);
  if (Number.isNaN(date.getTime())) return value.iso;
  try {
    return new Intl.DateTimeFormat(emailDateLocale(locale), {
      timeZone: value.timeZone || 'UTC',
      ...DATE_FORMATS[value.format],
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * CAMINO DEGRADADO NOMBRADO de los importes: una moneda que `Intl` no reconoce
 * (ISO 4217 inválido) cae a «<importe> <MONEDA>».
 *
 * Mismo criterio: el emisor ya no puede decidirlo porque el formato depende del
 * idioma, y un aviso de comisión sin importe no sirve de nada.
 */
function formatMoney(
  value: Extract<NotificationValue, { hubValue: 'money' }>,
  locale: string | null | undefined,
): string {
  const amount = value.cents / 100;
  try {
    return new Intl.NumberFormat(emailDateLocale(locale), {
      style: 'currency',
      currency: value.currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${value.currency.toUpperCase()}`;
  }
}

/** Un descriptor → su texto en el idioma del destinatario. */
export function resolveNotificationValue(
  value: NotificationValue,
  locale: string | null | undefined,
): string {
  switch (value.hubValue) {
    case 'date':
      return formatDate(value, locale);
    case 'money':
      return formatMoney(value, locale);
    case 'term':
      return resolveHubTerm(value.term, locale, value.vars);
  }
}

/**
 * Las `variables` de un envío con TODOS sus descriptores ya resueltos.
 *
 * Se aplica ANTES de renderizar y ANTES de persistir, así que la fila de
 * `notification` (y el evento realtime que la acompaña) guardan texto plano,
 * igual que hasta ahora: nadie aguas abajo —`notification-link.ts`, el toaster,
 * el panel de notificaciones— ve un descriptor.
 *
 * Los valores que NO son descriptores pasan tal cual, así que un emisor que no
 * tenga nada dependiente del idioma no cambia ni una línea.
 */
export function resolveNotificationVariables(
  variables: Record<string, unknown>,
  locale: string | null | undefined,
): Record<string, unknown> {
  let touched = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (isNotificationValue(value)) {
      out[key] = resolveNotificationValue(value, locale);
      touched = true;
    } else {
      out[key] = value;
    }
  }
  return touched ? out : variables;
}

/** Idiomas con términos declarados. Es la lista cerrada del catálogo. */
export const HUB_TERM_LANGS = HUB_TEMPLATE_LANGS;
