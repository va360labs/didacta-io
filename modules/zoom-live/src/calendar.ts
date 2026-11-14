/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Generación del evento de calendario de una clase en directo.
 *
 * Tres formatos, un mismo evento:
 *  - `.ics` (RFC 5545): lo entienden Apple Calendar, Outlook de escritorio,
 *    Thunderbird y el import de Google. Es el denominador común.
 *  - URL de Google Calendar: el flujo de un click para quien vive en Gmail.
 *  - URL de Outlook Web / Office 365: idem para quien vive en Microsoft.
 *
 * Qué NO viaja aquí: el `joinUrl` de Zoom. El enlace del evento apunta a
 * `/live/<id>` y es la página la que decide si enseñarlo (gating
 * server-side, ADR-017). Un `.ics` se reenvía, se sincroniza a móviles y se
 * comparte entre calendarios: meter el joinUrl dentro sería regalar el acceso
 * a la clase a cualquiera que reciba el evento.
 *
 * Idioma: el texto que escribimos nosotros (la descripción del evento y el
 * nombre del fichero) va en el idioma que pase quien llama (`locale`): el de
 * quien lo descarga si se sabe; si no, el del aula. Sin idioma, español, que
 * es lo de siempre y no cambia ni un byte. El título es el de la clase, tal
 * cual lo escribió el formador.
 */

/** Idiomas con texto propio en el evento (los del aula). */
export const CALENDAR_LOCALES = ['es', 'en', 'pt'] as const;
export type CalendarLocale = (typeof CALENDAR_LOCALES)[number];

/** Normaliza un idioma cualquiera (`pt-BR`, `en_US`, `fr`…) a uno con texto; si no, español. */
export function toCalendarLocale(raw: unknown): CalendarLocale {
  if (typeof raw !== 'string') return 'es';
  const base = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (CALENDAR_LOCALES as readonly string[]).includes(base) ? (base as CalendarLocale) : 'es';
}

const CALENDAR_TEXTS: Record<
  CalendarLocale,
  {
    /** Primera frase de la descripción: qué es y de quién. */
    what: (organizer: string) => string;
    /** Cómo se entra (descripción del `.ics` y de Google Calendar). */
    joinFrom: (url: string) => string;
    /** Versión corta para el cuerpo de Outlook (una sola línea). */
    joinFromShort: (url: string) => string;
    /** Prefijo del nombre del fichero `.ics` que se descarga. */
    fileName: string;
  }
> = {
  es: {
    what: (org) => `Clase en directo de ${org}.`,
    joinFrom: (url) => `Entra desde la página de la clase: ${url}`,
    joinFromShort: (url) => `Entra desde: ${url}`,
    fileName: 'clase',
  },
  en: {
    what: (org) => `Live class by ${org}.`,
    joinFrom: (url) => `Join from the class page: ${url}`,
    joinFromShort: (url) => `Join from: ${url}`,
    fileName: 'class',
  },
  pt: {
    // Sin «de»/«da»/«do» delante del nombre: no se sabe su género.
    what: (org) => `Aula ao vivo — ${org}.`,
    joinFrom: (url) => `Entre pela página da aula: ${url}`,
    joinFromShort: (url) => `Entre por: ${url}`,
    fileName: 'aula',
  },
};

function texts(input: { locale?: CalendarLocale }) {
  return CALENDAR_TEXTS[input.locale ?? 'es'] ?? CALENDAR_TEXTS.es;
}

/** Descripción larga del evento (`.ics` y Google Calendar). */
function longDescription(input: CalendarEventInput): string {
  const tx = texts(input);
  return input.classUrl
    ? `${tx.what(input.organizerName)}\n\n${tx.joinFrom(input.classUrl)}`
    : tx.what(input.organizerName);
}

/** Nombre del fichero `.ics` que se descarga: `clase-<id>.ics` en español. */
export function icsFileName(sessionId: string, locale?: CalendarLocale): string {
  return `${texts({ locale }).fileName}-${sessionId}.ics`;
}

export interface CalendarEventInput {
  /** UUID de la sesión — es también el UID estable del evento. */
  sessionId: string;
  topic: string;
  startTime: Date;
  durationMinutes: number;
  /**
   * URL absoluta a `/live/<id>` en el aula del tenant, o '' si el host no
   * conoce su dirección pública (ni dominio del tenant ni `WEB_PUBLIC_URL`).
   */
  classUrl: string;
  /** Nombre del tenant, para que el evento se reconozca en el calendario. */
  organizerName: string;
  /** Momento de generación (inyectable para tests deterministas). */
  now?: Date;
  /** Minutos de aviso del VALARM. 0 o negativo lo omite. */
  reminderMinutesBefore?: number;
  /** Idioma del texto que escribimos nosotros. Sin él, español. */
  locale?: CalendarLocale;
}

/** `20261201T160000Z` — forma UTC "basic" que exige RFC 5545 e ICS de Google. */
export function toIcsUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/** `2026-12-01T16:00:00Z` — forma extendida que espera el deeplink de Outlook. */
function toIsoSeconds(date: Date): string {
  return `${date.toISOString().split('.')[0]}Z`;
}

function endOf(input: CalendarEventInput): Date {
  return new Date(input.startTime.getTime() + input.durationMinutes * 60_000);
}

/**
 * Escapado de TEXT según RFC 5545 §3.3.11: la barra invertida primero (si no,
 * re-escaparíamos las que introducen las demás reglas).
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Plegado de líneas a 75 octetos (RFC 5545 §3.1). Contamos BYTES, no
 * caracteres: un título con acentos o emoji ocupa más de lo que mide
 * `String.length` y un corte por caracteres pasaría del límite. Cortamos
 * además por code point para no partir un carácter multibyte por la mitad.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  // Primera línea: 75 octetos. Las continuaciones gastan 1 en el espacio inicial.
  let limit = 75;

  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > limit) {
      out.push(current);
      current = '';
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += size;
  }
  if (current) out.push(current);

  return out.join('\r\n ');
}

/** Documento iCalendar completo con un único VEVENT. */
export function buildIcsEvent(input: CalendarEventInput): string {
  const now = input.now ?? new Date();
  const description = longDescription(input);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Didacta//Aula virtual//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // UID estable: reimportar el mismo evento actualiza el existente en vez
    // de duplicarlo, y una clase reprogramada pisa la entrada anterior.
    `UID:${input.sessionId}@didacta`,
    `DTSTAMP:${toIcsUtc(now)}`,
    `DTSTART:${toIcsUtc(input.startTime)}`,
    `DTEND:${toIcsUtc(endOf(input))}`,
    `SUMMARY:${escapeIcsText(input.topic)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    ...(input.classUrl
      ? [`URL:${escapeIcsText(input.classUrl)}`, `LOCATION:${escapeIcsText(input.classUrl)}`]
      : []),
    `ORGANIZER;CN=${escapeIcsText(input.organizerName)}:MAILTO:noreply@invalid`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
  ];

  const alarm = input.reminderMinutesBefore ?? 0;
  if (alarm > 0) {
    lines.push(
      'BEGIN:VALARM',
      `TRIGGER:-PT${alarm}M`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(input.topic)}`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // CRLF obligatorio (RFC 5545 §3.1) y salto final: Outlook de escritorio
  // rechaza el fichero si falta cualquiera de los dos.
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** URL de "añadir evento" de Google Calendar (no requiere sesión previa). */
export function buildGoogleCalendarUrl(input: CalendarEventInput): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.topic,
    dates: `${toIcsUtc(input.startTime)}/${toIcsUtc(endOf(input))}`,
    details: longDescription(input),
    ...(input.classUrl ? { location: input.classUrl } : {}),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Deeplink de "compose event" de Outlook. `personal` es outlook.live.com
 * (cuentas Hotmail/Outlook.com) y `work` es outlook.office.com (Microsoft
 * 365): son hosts distintos y el de una cuenta no sirve para la otra, así
 * que la UI ofrece los dos en vez de adivinar.
 */
export function buildOutlookCalendarUrl(
  input: CalendarEventInput,
  variant: 'personal' | 'work' = 'personal',
): string {
  const host = variant === 'work' ? 'outlook.office.com' : 'outlook.live.com';
  const tx = texts(input);
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: input.topic,
    startdt: toIsoSeconds(input.startTime),
    enddt: toIsoSeconds(endOf(input)),
    body: input.classUrl
      ? `${tx.what(input.organizerName)} ${tx.joinFromShort(input.classUrl)}`
      : tx.what(input.organizerName),
    ...(input.classUrl ? { location: input.classUrl } : {}),
  });
  return `https://${host}/calendar/0/deeplink/compose?${params.toString()}`;
}
