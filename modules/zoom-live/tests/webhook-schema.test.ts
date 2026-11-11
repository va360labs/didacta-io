/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { webhookEventSchema } from '../src/dto.js';

/**
 * El schema tiene que aceptar la forma REAL de los avisos de Zoom.
 *
 * `event_id` era obligatorio en el cuerpo, pero Zoom no lo manda: su forma es
 * `{ event, event_ts, payload }`. El schema rechazaba todo aviso real — el
 * endpoint respondía 200 IGNORED sin tocar la clase, así que Zoom no
 * reintentaba y el fallo era invisible. No se detectó porque los fixtures de
 * los tests inventaban su propio `event_id`.
 */
describe('webhookEventSchema · forma real de Zoom', () => {
  it('acepta un meeting.started real de Zoom, sin event_id en el cuerpo', () => {
    const result = webhookEventSchema.safeParse({
      event: 'meeting.started',
      event_ts: 1785781088000,
      payload: {
        account_id: 'abc123',
        object: {
          id: '87470222827',
          uuid: 'someUuid==',
          host_id: 'x1yCzABCDEfg23HiJKl4mN',
          topic: 'Clase 1',
          type: 2,
          start_time: '2026-08-03T18:18:08Z',
          timezone: 'Europe/Madrid',
          duration: 60,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('acepta un meeting.ended real de Zoom, sin event_id en el cuerpo', () => {
    const result = webhookEventSchema.safeParse({
      event: 'meeting.ended',
      event_ts: 1785782996000,
      payload: {
        account_id: 'abc123',
        object: {
          id: 87470222827,
          uuid: 'someUuid==',
          start_time: '2026-08-03T18:18:08Z',
          end_time: '2026-08-03T18:49:56Z',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('sigue aceptando un cuerpo que SÍ trae event_id (payloads hechos a mano)', () => {
    const result = webhookEventSchema.safeParse({ event_id: 'evt-1', event: 'meeting.started' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.event_id).toBe('evt-1');
  });

  it('rechaza un event_id vacío cuando sí viene', () => {
    expect(webhookEventSchema.safeParse({ event_id: '', event: 'meeting.started' }).success).toBe(
      false,
    );
  });

  it('recording.completed conserva los tramos de grabación (se usan para saber de cuándo es)', () => {
    const result = webhookEventSchema.safeParse({
      event: 'recording.completed',
      event_ts: 1785783100000,
      payload: {
        object: {
          id: 87470222827,
          share_url: 'https://zoom.example.test/rec/x',
          duration: 31,
          recording_files: [
            {
              id: 'f1',
              recording_start: '2026-08-03T18:18:10Z',
              recording_end: '2026-08-03T18:49:50Z',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.payload?.object?.recording_files).toEqual([
      { id: 'f1', recording_start: '2026-08-03T18:18:10Z', recording_end: '2026-08-03T18:49:50Z' },
    ]);
  });

  it('unos tramos de grabación con forma rara NO tiran el aviso', () => {
    for (const recording_files of ['texto', 7, null, [null, { recording_end: null }], {}]) {
      const result = webhookEventSchema.safeParse({
        event: 'recording.completed',
        payload: {
          object: { id: 1, share_url: 'https://zoom.example.test/rec/x', recording_files },
        },
      });
      expect(result.success, JSON.stringify(recording_files)).toBe(true);
    }
  });

  it('CONTROL: algo que no es un aviso (sin `event`) se sigue rechazando', () => {
    expect(webhookEventSchema.safeParse({ not: 'a webhook event' }).success).toBe(false);
  });
});
