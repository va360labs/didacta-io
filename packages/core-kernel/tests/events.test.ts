/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { EVENT_IDEMPOTENCY_KEY_MAX_LENGTH, eventIdempotencyKey } from '../src/module/events';

/**
 * La clave de idempotencia viaja a `outbox_event.idempotency_key`, bajo un
 * índice único cuya fila no pasa de 2.704 bytes en Postgres. Antes llevaba el
 * payload entero dentro: en cuanto el payload crecía, publicar el evento
 * reventaba — después de haber hecho ya la acción.
 */

/** La forma en que cada módulo componía la clave a mano. */
const claveAntigua = (name: string, data: unknown, ahora: number) =>
  `${name}:${JSON.stringify(data)}:${ahora}`;

/** Límite real de la fila de un índice btree de Postgres. */
const LIMITE_BTREE = 2704;

const AHORA = 1_762_862_400_000;

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

describe('eventIdempotencyKey', () => {
  it('con un payload pequeño es corta y legible: nombre, resumen y sufijo', () => {
    const key = eventIdempotencyKey('learning.enrollment.created', { enrollmentId: 'e-1' }, AHORA);

    expect(key).toMatch(/^learning\.enrollment\.created:[0-9a-f]{32}:1762862400000$/);
  });

  it('cancelar una clase con 200 inscritos: la clave ya no crece con la lista', () => {
    // El caso real: `zoom.session.cancelled` lleva a todos los inscritos en el
    // payload para que el puente de avisos no tenga que volver a preguntar.
    const data = {
      sessionId: uuid(0),
      topic: 'Clase en directo',
      registeredUserIds: Array.from({ length: 200 }, (_, i) => uuid(i + 1)),
    };

    // Así era: la clave pesa más del doble de lo que admite el índice.
    expect(claveAntigua('zoom.session.cancelled', data, AHORA).length).toBeGreaterThan(
      LIMITE_BTREE,
    );

    const key = eventIdempotencyKey('zoom.session.cancelled', data, AHORA);
    expect(key.length).toBeLessThanOrEqual(EVENT_IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(key.length).toBe('zoom.session.cancelled'.length + 1 + 32 + 1 + 13);
  });

  it('texto libre en el payload (el error de un proveedor, el motivo de un moderador)', () => {
    const data = { courseId: uuid(1), reason: '<html>'.padEnd(50_000, 'x') };

    const key = eventIdempotencyKey('ai-tutor.course.index-failed', data, AHORA);

    expect(key.length).toBeLessThanOrEqual(EVENT_IDEMPOTENCY_KEY_MAX_LENGTH);
  });

  it('el tope queda muy por debajo del límite del índice', () => {
    expect(EVENT_IDEMPOTENCY_KEY_MAX_LENGTH).toBeLessThan(LIMITE_BTREE / 4);
  });

  describe('no cambia la semántica: quién se deduplica y quién no', () => {
    it('mismo evento, mismo payload, mismo instante → la misma clave', () => {
      const a = eventIdempotencyKey('x.y', { id: 1, tags: ['a', 'b'] }, AHORA);
      const b = eventIdempotencyKey('x.y', { id: 1, tags: ['a', 'b'] }, AHORA);
      expect(a).toBe(b);
    });

    it('el orden de las claves del payload no cuenta: es el mismo payload', () => {
      const a = eventIdempotencyKey('x.y', { userId: 'u', courseId: 'c' }, AHORA);
      const b = eventIdempotencyKey('x.y', { courseId: 'c', userId: 'u' }, AHORA);
      expect(a).toBe(b);
    });

    it('payloads distintos en el mismo instante → claves distintas', () => {
      const a = eventIdempotencyKey('x.y', { userId: 'u-1' }, AHORA);
      const b = eventIdempotencyKey('x.y', { userId: 'u-2' }, AHORA);
      expect(a).not.toBe(b);
    });

    it('dos payloads enormes que solo difieren al final siguen distinguiéndose', () => {
      // Recortar la clave antigua a 256 caracteres los habría confundido.
      const base = Array.from({ length: 500 }, (_, i) => uuid(i));
      const a = eventIdempotencyKey('x.y', { ids: [...base, 'ana'] }, AHORA);
      const b = eventIdempotencyKey('x.y', { ids: [...base, 'beto'] }, AHORA);
      expect(a).not.toBe(b);
    });

    it('el orden de un ARRAY sí cuenta: no es el mismo payload', () => {
      const a = eventIdempotencyKey('x.y', { ids: ['a', 'b'] }, AHORA);
      const b = eventIdempotencyKey('x.y', { ids: ['b', 'a'] }, AHORA);
      expect(a).not.toBe(b);
    });

    it('la misma publicación en otro instante es OTRA ocurrencia', () => {
      const a = eventIdempotencyKey('x.y', { id: 1 }, AHORA);
      const b = eventIdempotencyKey('x.y', { id: 1 }, AHORA + 1);
      expect(a).not.toBe(b);
    });

    it('eventos distintos con el mismo payload no chocan', () => {
      const a = eventIdempotencyKey('community.post.hidden', { postId: 'p' }, AHORA);
      const b = eventIdempotencyKey('community.post.unhidden', { postId: 'p' }, AHORA);
      expect(a).not.toBe(b);
    });

    it('sin sufijo usa el reloj: cada llamada es una ocurrencia', () => {
      const antes = Date.now();
      const key = eventIdempotencyKey('x.y', { id: 1 });
      const sufijo = Number(key.split(':').at(-1));
      expect(sufijo).toBeGreaterThanOrEqual(antes);
      expect(sufijo).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('con un identificador natural, la clave es estable de verdad', () => {
    it('reintentar la misma ocurrencia da la misma clave aunque pase el tiempo', () => {
      const a = eventIdempotencyKey('billing.order.completed', { orderId: 'o-1' }, 'o-1');
      const b = eventIdempotencyKey('billing.order.completed', { orderId: 'o-1' }, 'o-1');
      expect(a).toBe(b);
    });
  });

  describe('casos límite: nunca se pasa del tope y nunca lanza', () => {
    it('un nombre de evento kilométrico sigue acotado y sigue distinguiendo', () => {
      const largo = 'modulo.'.repeat(100);
      const a = eventIdempotencyKey(largo, { id: 1 }, AHORA);
      const b = eventIdempotencyKey(largo, { id: 2 }, AHORA);
      const c = eventIdempotencyKey(largo, { id: 1 }, AHORA + 1);

      for (const k of [a, b, c])
        expect(k.length).toBeLessThanOrEqual(EVENT_IDEMPOTENCY_KEY_MAX_LENGTH);
      // Recortar por la cola habría dejado las tres iguales: el payload y el
      // instante van al final.
      expect(new Set([a, b, c]).size).toBe(3);
      expect(a.startsWith('modulo.modulo.')).toBe(true);
    });

    it('un sufijo kilométrico tampoco se pierde al acotar', () => {
      const a = eventIdempotencyKey('x.y', { id: 1 }, `${'s'.repeat(600)}-uno`);
      const b = eventIdempotencyKey('x.y', { id: 1 }, `${'s'.repeat(600)}-dos`);

      expect(a.length).toBeLessThanOrEqual(EVENT_IDEMPOTENCY_KEY_MAX_LENGTH);
      expect(a).not.toBe(b);
    });

    it('una referencia circular no tumba la publicación', () => {
      const circular: Record<string, unknown> = { id: 1 };
      circular['self'] = circular;

      expect(() => eventIdempotencyKey('x.y', circular, AHORA)).not.toThrow();
      expect(eventIdempotencyKey('x.y', circular, AHORA).length).toBeLessThanOrEqual(
        EVENT_IDEMPOTENCY_KEY_MAX_LENGTH,
      );
    });

    it('un BigInt en el payload (ids de outbox, de auditoría) no lanza y distingue', () => {
      const a = eventIdempotencyKey('x.y', { id: 1n }, AHORA);
      const b = eventIdempotencyKey('x.y', { id: 2n }, AHORA);
      expect(a).not.toBe(b);
    });

    it('payload undefined o null', () => {
      expect(eventIdempotencyKey('x.y', undefined, AHORA)).toMatch(/^x\.y:[0-9a-f]{32}:/);
      expect(eventIdempotencyKey('x.y', null, AHORA)).not.toBe(
        eventIdempotencyKey('x.y', undefined, AHORA),
      );
    });

    it('las fechas del payload cuentan', () => {
      const a = eventIdempotencyKey('x.y', { at: new Date('2026-01-01T00:00:00Z') }, AHORA);
      const b = eventIdempotencyKey('x.y', { at: new Date('2026-01-02T00:00:00Z') }, AHORA);
      expect(a).not.toBe(b);
    });
  });
});
