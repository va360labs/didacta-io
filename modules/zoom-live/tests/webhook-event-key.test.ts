/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import type { ZoomWebhookEvent } from '../src/dto.js';
import { DERIVED_EVENT_KEY_PREFIX, webhookEventKey } from '../src/webhook-event-key.js';

/**
 * La clave de idempotencia de un aviso no puede depender de `event_id`: Zoom
 * no lo manda. Tiene que salir del contenido, repetirse en una reentrega y
 * cambiar entre sucesos distintos.
 */
const started: ZoomWebhookEvent = {
  event: 'meeting.started',
  event_ts: 1785781088000,
  payload: { account_id: 'acc', object: { id: '87470222827', uuid: 'uuid-1==' } },
};

describe('webhookEventKey', () => {
  it('una reentrega del mismo aviso da la misma clave', () => {
    const reentrega = JSON.parse(JSON.stringify(started)) as ZoomWebhookEvent;
    expect(webhookEventKey(reentrega)).toBe(webhookEventKey(started));
    expect(webhookEventKey(started).startsWith(DERIVED_EVENT_KEY_PREFIX)).toBe(true);
  });

  it('no depende del cuerpo crudo cuando hay event_ts: da igual cómo venga serializado', () => {
    const compacto = JSON.stringify(started);
    const conEspacios = JSON.stringify(started, null, 2);
    expect(webhookEventKey(started, compacto)).toBe(webhookEventKey(started, conEspacios));
    expect(webhookEventKey(started, compacto)).toBe(webhookEventKey(started));
  });

  it('el id de la reunión como número o como texto es el mismo suceso', () => {
    const numerico: ZoomWebhookEvent = {
      ...started,
      payload: { account_id: 'acc', object: { id: 87470222827, uuid: 'uuid-1==' } },
    };
    expect(webhookEventKey(numerico)).toBe(webhookEventKey(started));
  });

  it('sucesos distintos dan claves distintas', () => {
    const base = webhookEventKey(started);
    // Otro tipo de aviso sobre la misma reunión.
    expect(webhookEventKey({ ...started, event: 'meeting.ended' })).not.toBe(base);
    // El mismo tipo, en otro momento.
    expect(webhookEventKey({ ...started, event_ts: 1785781088001 })).not.toBe(base);
    // Otra ocurrencia de una reunión recurrente.
    expect(
      webhookEventKey({
        ...started,
        payload: { account_id: 'acc', object: { id: '87470222827', uuid: 'uuid-2==' } },
      }),
    ).not.toBe(base);
    // Otra reunión.
    expect(
      webhookEventKey({
        ...started,
        payload: { account_id: 'acc', object: { id: '111', uuid: 'uuid-1==' } },
      }),
    ).not.toBe(base);
    // Otra cuenta de Zoom.
    expect(
      webhookEventKey({
        ...started,
        payload: { account_id: 'otra', object: { id: '87470222827', uuid: 'uuid-1==' } },
      }),
    ).not.toBe(base);
  });

  it('si el cuerpo trae event_id, se usa tal cual', () => {
    expect(webhookEventKey({ ...started, event_id: 'evt-de-zoom' })).toBe('evt-de-zoom');
  });

  it('sin event_ts la clave sale del cuerpo crudo: una reentrega lo repite', () => {
    const sinFecha: ZoomWebhookEvent = { event: 'meeting.ended', payload: started.payload };
    const rawA = '{"event":"meeting.ended","payload":{"object":{"id":"1","end_time":"A"}}}';
    const rawB = '{"event":"meeting.ended","payload":{"object":{"id":"1","end_time":"B"}}}';
    expect(webhookEventKey(sinFecha, rawA)).toBe(webhookEventKey(sinFecha, rawA));
    expect(webhookEventKey(sinFecha, rawA)).not.toBe(webhookEventKey(sinFecha, rawB));
  });

  it('sin event_ts ni cuerpo crudo sigue habiendo clave, y es estable', () => {
    const sinFecha: ZoomWebhookEvent = { event: 'meeting.ended', payload: started.payload };
    expect(webhookEventKey(sinFecha)).toBe(webhookEventKey(sinFecha));
    expect(webhookEventKey(sinFecha)).not.toBe(webhookEventKey({ ...sinFecha, event: 'x' }));
  });

  it('un aviso mínimo (solo `event`) no revienta', () => {
    expect(webhookEventKey({ event: 'meeting.started' })).toMatch(/^derived-[0-9a-f]{40}$/);
  });
});
