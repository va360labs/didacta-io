/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { EARLY_EVENT_MARGIN_MINUTES, isFalseStart } from '../src/false-start.js';

/**
 * ¿El aviso de Zoom es de la clase, o de alguien que abrió la reunión fuera de
 * hora? Clase a las 17:30 (hora de Madrid) del 9 de noviembre.
 */
const START = new Date('2026-11-09T17:30:00+01:00');
const at = (iso: string) => new Date(iso);
const ms = (iso: string) => new Date(iso).getTime();

describe('isFalseStart', () => {
  it('el margen de arranque es de media hora', () => {
    expect(EARLY_EVENT_MARGIN_MINUTES).toBe(30);
  });

  describe('meeting.started', () => {
    it('días antes: falso arranque', () => {
      expect(
        isFalseStart({ event: 'meeting.started' }, START, at('2026-11-07T19:00:00+01:00')),
      ).toBe(true);
    });

    it('31 minutos antes: falso arranque; 30 minutos antes: ya es la clase', () => {
      expect(
        isFalseStart({ event: 'meeting.started' }, START, at('2026-11-09T16:59:00+01:00')),
      ).toBe(true);
      expect(
        isFalseStart({ event: 'meeting.started' }, START, at('2026-11-09T17:00:00+01:00')),
      ).toBe(false);
    });

    it('después de la hora: es la clase', () => {
      expect(
        isFalseStart({ event: 'meeting.started' }, START, at('2026-11-09T17:45:00+01:00')),
      ).toBe(false);
    });
  });

  describe('meeting.ended', () => {
    it('antes de la hora de inicio: una clase no termina antes de empezar', () => {
      expect(isFalseStart({ event: 'meeting.ended' }, START, at('2026-11-07T19:05:00+01:00'))).toBe(
        true,
      );
      expect(isFalseStart({ event: 'meeting.ended' }, START, at('2026-11-09T17:29:59+01:00'))).toBe(
        true,
      );
    });

    it('a la hora o después: es el final de la clase', () => {
      expect(isFalseStart({ event: 'meeting.ended' }, START, at('2026-11-09T17:30:00+01:00'))).toBe(
        false,
      );
      expect(isFalseStart({ event: 'meeting.ended' }, START, at('2026-11-09T18:40:00+01:00'))).toBe(
        false,
      );
    });
  });

  describe('cuenta cuándo OCURRIÓ (event_ts), no cuándo llegó', () => {
    it('un ended de una prueba hecha antes de la clase, reentregado con la clase empezada, sigue siendo falso', () => {
      const event = { event: 'meeting.ended', event_ts: ms('2026-11-09T16:40:00+01:00') };
      expect(isFalseStart(event, START, at('2026-11-09T17:45:00+01:00'))).toBe(true);
    });

    it('un ended de la clase de verdad que llega tarde se aplica', () => {
      const event = { event: 'meeting.ended', event_ts: ms('2026-11-09T18:31:00+01:00') };
      expect(isFalseStart(event, START, at('2026-11-09T20:00:00+01:00'))).toBe(false);
    });

    it('un event_ts adelantado no se cree: manda el momento de llegada', () => {
      // «Ocurrió» después de la clase según el aviso, pero ha llegado días antes.
      const event = { event: 'meeting.ended', event_ts: ms('2026-11-09T18:31:00+01:00') };
      expect(isFalseStart(event, START, at('2026-11-07T19:05:00+01:00'))).toBe(true);
    });

    it('un event_ts que no es una fecha válida se ignora', () => {
      expect(
        isFalseStart(
          { event: 'meeting.ended', event_ts: 0 },
          START,
          at('2026-11-09T18:40:00+01:00'),
        ),
      ).toBe(false);
    });
  });

  describe('recording.completed', () => {
    const recording = (ends: unknown) => ({
      event: 'recording.completed',
      payload: { object: { recording_files: ends } },
    });

    it('la grabación acabó antes de la hora: es la de la prueba, aunque el aviso llegue después', () => {
      const event = recording([
        { recording_end: '2026-11-07T18:10:00Z' },
        { recording_end: '2026-11-07T18:12:00Z' },
      ]);
      expect(isFalseStart(event, START, at('2026-11-09T19:00:00+01:00'))).toBe(true);
    });

    it('la grabación acabó después de la hora: es la de la clase', () => {
      const event = recording([{ recording_end: '2026-11-09T17:35:00Z' }]);
      expect(isFalseStart(event, START, at('2026-11-09T19:00:00+01:00'))).toBe(false);
    });

    it('con varios tramos cuenta el último', () => {
      const event = recording([
        { recording_end: '2026-11-07T18:10:00Z' },
        { recording_end: '2026-11-09T17:35:00Z' },
      ]);
      expect(isFalseStart(event, START, at('2026-11-09T19:00:00+01:00'))).toBe(false);
    });

    it('sin fin de tramo utilizable cuenta el momento del aviso', () => {
      for (const files of [undefined, [], 'no-es-una-lista', [null, { recording_end: 'x' }, 7]]) {
        expect(isFalseStart(recording(files), START, at('2026-11-07T19:10:00+01:00'))).toBe(true);
        expect(isFalseStart(recording(files), START, at('2026-11-09T19:00:00+01:00'))).toBe(false);
      }
    });
  });

  it('cualquier otro aviso nunca es un falso arranque', () => {
    expect(
      isFalseStart({ event: 'meeting.participant_joined' }, START, at('2026-11-07T19:00:00+01:00')),
    ).toBe(false);
  });
});
