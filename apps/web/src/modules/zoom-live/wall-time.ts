/// Conversión hora-de-pared ↔ instante para el formulario de clases en directo.
///
/// El input `datetime-local` da "2026-08-03T18:00" SIN zona. Pasarlo por
/// `new Date(...)` lo interpreta en la zona del NAVEGADOR, que no tiene por
/// qué ser la zona declarada de la clase: un formador de vacaciones en
/// Canarias creando una clase "Europe/Madrid" la programaría una hora tarde.
/// Aquí interpretamos las cifras en la zona elegida.

/** Offset (ms) de `timeZone` respecto a UTC para un instante concreto. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asIfUtc - instant.getTime();
}

/**
 * Convierte la hora de pared de un `datetime-local` ("YYYY-MM-DDTHH:mm") en la
 * zona `timeZone` al instante ISO en UTC que consume la API.
 *
 * Doble pasada para los saltos de horario de verano: el offset se calcula con
 * una estimación y se recalcula sobre el instante resultante; si cambió (la
 * fecha cae justo en el salto), se aplica el bueno.
 *
 * Si la zona es inválida cae al comportamiento del navegador, que es lo que
 * hacía antes — nunca impide crear la clase.
 */
export function wallTimeToIso(wall: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall.trim());
  if (!m) return new Date(wall).toISOString();

  const asIfUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0,
  );
  try {
    const firstOffset = zoneOffsetMs(new Date(asIfUtc), timeZone);
    let instant = asIfUtc - firstOffset;
    const secondOffset = zoneOffsetMs(new Date(instant), timeZone);
    if (secondOffset !== firstOffset) instant = asIfUtc - secondOffset;
    return new Date(instant).toISOString();
  } catch {
    return new Date(wall).toISOString();
  }
}

/** ¿Es una zona IANA que este navegador entiende? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Zonas ofrecidas en el desplegable. No son datos de negocio inventados: son
 * identificadores IANA fijos. La zona del navegador se añade aparte si no está.
 */
export const COMMON_TIMEZONES = [
  'Europe/Madrid',
  'Atlantic/Canary',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Paris',
  'America/Argentina/Buenos_Aires',
  'America/Mexico_City',
  'America/Bogota',
  'America/Santiago',
  'America/Lima',
  'America/New_York',
  'UTC',
];

/** Etiqueta legible con el offset actual, ej. "Europe/Madrid (GMT+2)". */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat('es-ES', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return name ? `${timeZone} (${name})` : timeZone;
  } catch {
    return timeZone;
  }
}
