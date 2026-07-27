import { describe, expect, it } from 'vitest';
import { toZoomWallTime } from '../src/zoom-api-client.js';

/**
 * Zoom interpreta las cifras de `start_time` en la `timezone` que le mandes,
 * ignorando el sufijo Z. Verificado contra la API real el 2026-07-27:
 * enviar `10:00:00.000Z` + `Europe/Madrid` dejaba el meeting a las 08:00Z,
 * dos horas antes de lo que Didacta le muestra al alumno.
 *
 * Por eso convertimos el instante a hora de pared de esa zona y lo mandamos
 * SIN Z. Estos tests fijan ese contrato, incluidos los saltos de horario de
 * verano (España: CET +1 en invierno, CEST +2 en verano).
 */
describe('toZoomWallTime', () => {
  it('convierte a hora de pared de Madrid en verano (CEST, +2)', () => {
    // La clase de producción que destapó el bug: 18:00 de Madrid.
    expect(toZoomWallTime('2026-08-03T16:00:00.000Z', 'Europe/Madrid')).toBe('2026-08-03T18:00:00');
  });

  it('convierte a hora de pared de Madrid en invierno (CET, +1)', () => {
    expect(toZoomWallTime('2026-01-15T17:00:00.000Z', 'Europe/Madrid')).toBe('2026-01-15T18:00:00');
  });

  it('respeta el cambio de hora de octubre (mismo día, distinto offset)', () => {
    // 2026-10-25: España atrasa el reloj a las 03:00 CEST → 02:00 CET.
    expect(toZoomWallTime('2026-10-25T00:30:00.000Z', 'Europe/Madrid')).toBe(
      '2026-10-25T02:30:00', // aún CEST (+2)
    );
    expect(toZoomWallTime('2026-10-25T02:30:00.000Z', 'Europe/Madrid')).toBe(
      '2026-10-25T03:30:00', // ya CET (+1)
    );
  });

  it('acepta ISO con offset explícito, no solo Z', () => {
    // 10:00 en Buenos Aires (-03) = 13:00 UTC = 15:00 en Madrid.
    expect(toZoomWallTime('2026-08-03T10:00:00-03:00', 'Europe/Madrid')).toBe(
      '2026-08-03T15:00:00',
    );
  });

  it('mantiene el instante en zonas que cruzan de día', () => {
    // 23:30 UTC del 3 de agosto son las 08:30 del día 4 en Tokio.
    expect(toZoomWallTime('2026-08-03T23:30:00.000Z', 'Asia/Tokyo')).toBe('2026-08-04T08:30:00');
  });

  it('formatea medianoche como 00:00:00, nunca 24:00:00', () => {
    expect(toZoomWallTime('2026-08-03T22:00:00.000Z', 'Europe/Madrid')).toBe('2026-08-04T00:00:00');
  });

  it('cae a UTC si la timezone es inválida o falta, sin romper la creación', () => {
    expect(toZoomWallTime('2026-08-03T16:00:00.000Z', 'No/Existe')).toBe('2026-08-03T16:00:00');
    expect(toZoomWallTime('2026-08-03T16:00:00.000Z', undefined)).toBe('2026-08-03T16:00:00');
    expect(toZoomWallTime('2026-08-03T16:00:00.000Z', '  ')).toBe('2026-08-03T16:00:00');
  });

  it('devuelve la entrada intacta si no es una fecha parseable', () => {
    expect(toZoomWallTime('no-es-una-fecha', 'Europe/Madrid')).toBe('no-es-una-fecha');
  });
});
