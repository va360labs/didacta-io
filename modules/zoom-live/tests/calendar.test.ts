import { describe, expect, it } from 'vitest';
import {
  buildGoogleCalendarUrl,
  buildIcsEvent,
  buildOutlookCalendarUrl,
  icsFileName,
  toCalendarLocale,
  toIcsUtc,
  type CalendarEventInput,
} from '../src/calendar.js';

const base: CalendarEventInput = {
  sessionId: '11111111-2222-3333-4444-555555555555',
  topic: 'Clase de prospección',
  startTime: new Date('2026-12-01T16:00:00.000Z'),
  durationMinutes: 90,
  classUrl: 'https://aula.example.test/live/11111111-2222-3333-4444-555555555555',
  organizerName: 'Demo',
  now: new Date('2026-11-30T10:00:00.000Z'),
};

/** Deshace el plegado RFC 5545 para poder afirmar sobre líneas lógicas. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, '').split('\r\n');
}

describe('buildIcsEvent', () => {
  it('genera un VEVENT válido con inicio, fin y UID estable', () => {
    const lines = unfold(buildIcsEvent(base));

    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('UID:11111111-2222-3333-4444-555555555555@didacta');
    expect(lines).toContain('DTSTART:20261201T160000Z');
    // 16:00 + 90 min.
    expect(lines).toContain('DTEND:20261201T173000Z');
    expect(lines).toContain('DTSTAMP:20261130T100000Z');
    expect(lines).toContain('SUMMARY:Clase de prospección');
    expect(lines).toContain('END:VCALENDAR');
  });

  it('termina en CRLF: Outlook de escritorio rechaza el fichero sin él', () => {
    const ics = buildIcsEvent(base);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.includes('\n\n')).toBe(false);
  });

  it('NUNCA incluye el joinUrl de Zoom — un .ics se reenvía (ADR-017)', () => {
    const ics = buildIcsEvent(base);
    expect(ics).not.toMatch(/zoom\.us/i);
    expect(ics).toContain('/live/11111111-2222-3333-4444-555555555555');
  });

  it('escapa comas, puntos y coma, barras y saltos de línea del título', () => {
    const lines = unfold(
      buildIcsEvent({ ...base, topic: 'Ventas: guion, objeciones; cierre \\ bonus' }),
    );
    expect(lines).toContain('SUMMARY:Ventas: guion\\, objeciones\\; cierre \\\\ bonus');
  });

  it('pliega las líneas largas a 75 octetos con continuación indentada', () => {
    const ics = buildIcsEvent({ ...base, topic: 'á'.repeat(120) });
    const rawLines = ics.split('\r\n').filter((l) => l.length > 0);
    for (const line of rawLines) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // El plegado es reversible: el título vuelve entero al deshacerlo.
    expect(unfold(ics)).toContain(`SUMMARY:${'á'.repeat(120)}`);
  });

  it('añade el aviso VALARM solo si se pide', () => {
    expect(buildIcsEvent(base)).not.toContain('BEGIN:VALARM');
    const withAlarm = unfold(buildIcsEvent({ ...base, reminderMinutesBefore: 30 }));
    expect(withAlarm).toContain('BEGIN:VALARM');
    expect(withAlarm).toContain('TRIGGER:-PT30M');
  });

  it('sin dirección pública del aula omite URL/LOCATION en vez de escribir un enlace roto', () => {
    const ics = buildIcsEvent({ ...base, classUrl: '' });
    expect(ics).not.toContain('URL:');
    expect(ics).not.toContain('LOCATION:');
    expect(ics).toContain('SUMMARY:Clase de prospección');
  });
});

describe('toIcsUtc', () => {
  it('usa la forma básica UTC que exige RFC 5545', () => {
    expect(toIcsUtc(new Date('2026-01-05T08:07:06.123Z'))).toBe('20260105T080706Z');
  });
});

describe('buildGoogleCalendarUrl', () => {
  it('lleva el rango en formato básico UTC y el enlace de la clase', () => {
    const url = new URL(buildGoogleCalendarUrl(base));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Clase de prospección');
    expect(url.searchParams.get('dates')).toBe('20261201T160000Z/20261201T173000Z');
    expect(url.searchParams.get('location')).toBe(base.classUrl);
  });
});

describe('buildOutlookCalendarUrl', () => {
  it('usa outlook.live.com para cuentas personales y fechas ISO extendidas', () => {
    const url = new URL(buildOutlookCalendarUrl(base, 'personal'));
    expect(url.host).toBe('outlook.live.com');
    expect(url.searchParams.get('startdt')).toBe('2026-12-01T16:00:00Z');
    expect(url.searchParams.get('enddt')).toBe('2026-12-01T17:30:00Z');
    expect(url.searchParams.get('subject')).toBe('Clase de prospección');
  });

  it('usa outlook.office.com para cuentas de Microsoft 365', () => {
    expect(new URL(buildOutlookCalendarUrl(base, 'work')).host).toBe('outlook.office.com');
  });
});

describe('idioma del evento', () => {
  /** La DESCRIPTION del `.ics`, ya desplegada y sin escapar. */
  function icsDescription(input: CalendarEventInput): string {
    const line = unfold(buildIcsEvent(input)).find((l) => l.startsWith('DESCRIPTION:'))!;
    return line
      .slice('DESCRIPTION:'.length)
      .replace(/\\n/g, '\n')
      .replace(/\\([,;\\])/g, '$1');
  }

  it('sin idioma, el español de siempre (texto exacto en los tres formatos)', () => {
    expect(icsDescription(base)).toBe(
      `Clase en directo de Demo.\n\nEntra desde la página de la clase: ${base.classUrl}`,
    );
    expect(icsDescription({ ...base, classUrl: '' })).toBe('Clase en directo de Demo.');
    expect(new URL(buildGoogleCalendarUrl(base)).searchParams.get('details')).toBe(
      `Clase en directo de Demo.\n\nEntra desde la página de la clase: ${base.classUrl}`,
    );
    expect(new URL(buildOutlookCalendarUrl(base)).searchParams.get('body')).toBe(
      `Clase en directo de Demo. Entra desde: ${base.classUrl}`,
    );
    expect(icsFileName(base.sessionId)).toBe(`clase-${base.sessionId}.ics`);
    // Pedir español explícitamente da exactamente lo mismo.
    expect(buildIcsEvent({ ...base, locale: 'es' })).toBe(buildIcsEvent(base));
    expect(buildGoogleCalendarUrl({ ...base, locale: 'es' })).toBe(buildGoogleCalendarUrl(base));
    expect(buildOutlookCalendarUrl({ ...base, locale: 'es' })).toBe(buildOutlookCalendarUrl(base));
  });

  it('en portugués de Brasil', () => {
    const pt = { ...base, locale: 'pt' as const };
    expect(icsDescription(pt)).toBe(
      `Aula ao vivo — Demo.\n\nEntre pela página da aula: ${base.classUrl}`,
    );
    expect(icsDescription({ ...pt, classUrl: '' })).toBe('Aula ao vivo — Demo.');
    expect(new URL(buildGoogleCalendarUrl(pt)).searchParams.get('details')).toBe(
      `Aula ao vivo — Demo.\n\nEntre pela página da aula: ${base.classUrl}`,
    );
    expect(new URL(buildOutlookCalendarUrl(pt)).searchParams.get('body')).toBe(
      `Aula ao vivo — Demo. Entre por: ${base.classUrl}`,
    );
    expect(icsFileName(base.sessionId, 'pt')).toBe(`aula-${base.sessionId}.ics`);
    // El título es el de la clase: no se traduce.
    expect(unfold(buildIcsEvent(pt))).toContain('SUMMARY:Clase de prospección');
  });

  it('en inglés', () => {
    const en = { ...base, locale: 'en' as const };
    expect(icsDescription(en)).toBe(
      `Live class by Demo.\n\nJoin from the class page: ${base.classUrl}`,
    );
    expect(new URL(buildOutlookCalendarUrl(en)).searchParams.get('body')).toBe(
      `Live class by Demo. Join from: ${base.classUrl}`,
    );
    expect(icsFileName(base.sessionId, 'en')).toBe(`class-${base.sessionId}.ics`);
  });

  it('cualquier tag se reduce a un idioma con texto; sin texto propio, español', () => {
    expect(toCalendarLocale('pt-BR')).toBe('pt');
    expect(toCalendarLocale('en_US')).toBe('en');
    expect(toCalendarLocale('es-AR')).toBe('es');
    expect(toCalendarLocale('fr-FR')).toBe('es');
    expect(toCalendarLocale(undefined)).toBe('es');
    expect(icsDescription({ ...base, locale: toCalendarLocale('fr-FR') })).toBe(
      icsDescription(base),
    );
  });
});
