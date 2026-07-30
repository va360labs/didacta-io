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
 * `/clase/<id>` y es la página la que decide si enseñarlo (gating
 * server-side, ADR-017). Un `.ics` se reenvía, se sincroniza a móviles y se
 * comparte entre calendarios: meter el joinUrl dentro sería regalar el acceso
 * a la clase a cualquiera que reciba el evento.
 */

export interface CalendarEventInput {
  /** UUID de la sesión — es también el UID estable del evento. */
  sessionId: string;
  topic: string;
  startTime: Date;
  durationMinutes: number;
  /** URL absoluta a `/clase/<id>`, o '' si `WEB_PUBLIC_URL` no está puesta. */
  classUrl: string;
  /** Nombre del tenant, para que el evento se reconozca en el calendario. */
  organizerName: string;
  /** Momento de generación (inyectable para tests deterministas). */
  now?: Date;
  /** Minutos de aviso del VALARM. 0 o negativo lo omite. */
  reminderMinutesBefore?: number;
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
  const description = input.classUrl
    ? `Clase en directo de ${input.organizerName}.\n\nEntra desde la página de la clase: ${input.classUrl}`
    : `Clase en directo de ${input.organizerName}.`;

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
    details: input.classUrl
      ? `Clase en directo de ${input.organizerName}.\n\nEntra desde la página de la clase: ${input.classUrl}`
      : `Clase en directo de ${input.organizerName}.`,
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
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: input.topic,
    startdt: toIsoSeconds(input.startTime),
    enddt: toIsoSeconds(endOf(input)),
    body: input.classUrl
      ? `Clase en directo de ${input.organizerName}. Entra desde: ${input.classUrl}`
      : `Clase en directo de ${input.organizerName}.`,
    ...(input.classUrl ? { location: input.classUrl } : {}),
  });
  return `https://${host}/calendar/0/deeplink/compose?${params.toString()}`;
}
