import { describe, expect, it } from 'vitest';
import { isValidTimeZone, wallTimeToIso } from './wall-time';

/**
 * El formulario del formador escribe la hora en un `datetime-local`, que no
 * lleva zona. Antes se resolvía con `new Date(...)`, es decir en la zona del
 * NAVEGADOR: un formador conectado desde otra zona programaba la clase a una
 * hora distinta de la que declaraba.
 */
describe('wallTimeToIso', () => {
  it('interpreta la hora en la zona elegida, no en la del navegador (verano)', () => {
    // 18:00 en Madrid en agosto (CEST, +2) = 16:00 UTC.
    expect(wallTimeToIso('2026-08-03T18:00', 'Europe/Madrid')).toBe('2026-08-03T16:00:00.000Z');
  });

  it('aplica el offset de invierno cuando toca (CET, +1)', () => {
    expect(wallTimeToIso('2026-01-15T18:00', 'Europe/Madrid')).toBe('2026-01-15T17:00:00.000Z');
  });

  it('da instantes distintos para la misma hora en zonas distintas', () => {
    const madrid = wallTimeToIso('2026-08-03T18:00', 'Europe/Madrid');
    const canarias = wallTimeToIso('2026-08-03T18:00', 'Atlantic/Canary');
    const buenosAires = wallTimeToIso('2026-08-03T18:00', 'America/Argentina/Buenos_Aires');
    expect(madrid).toBe('2026-08-03T16:00:00.000Z');
    expect(canarias).toBe('2026-08-03T17:00:00.000Z'); // WEST, +1
    expect(buenosAires).toBe('2026-08-03T21:00:00.000Z'); // ART, -3
  });

  it('resuelve correctamente el día del cambio de hora', () => {
    // 2026-10-25 en España: a las 03:00 CEST el reloj vuelve a las 02:00 CET.
    // Las 04:00 de ese día ya son CET (+1).
    expect(wallTimeToIso('2026-10-25T04:00', 'Europe/Madrid')).toBe('2026-10-25T03:00:00.000Z');
    // Las 01:00 aún son CEST (+2).
    expect(wallTimeToIso('2026-10-25T01:00', 'Europe/Madrid')).toBe('2026-10-24T23:00:00.000Z');
  });

  it('trata UTC como identidad', () => {
    expect(wallTimeToIso('2026-08-03T18:00', 'UTC')).toBe('2026-08-03T18:00:00.000Z');
  });

  it('con zona inválida no rompe y devuelve un ISO válido', () => {
    const iso = wallTimeToIso('2026-08-03T18:00', 'No/Existe');
    expect(() => new Date(iso).toISOString()).not.toThrow();
    expect(iso).toMatch(/^2026-08-0\dT\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('isValidTimeZone', () => {
  it('distingue zonas IANA reales de inventadas', () => {
    expect(isValidTimeZone('Europe/Madrid')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('No/Existe')).toBe(false);
  });
});
