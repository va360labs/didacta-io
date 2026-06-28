/**
 * Tests de la lógica pura del DRIP (computeDripAvailability), sin DB.
 *
 * Cubre: intervalo relativo por lección y por módulo, ancla (día 0), "gana el más
 * permisivo" cuando aplican varias reglas, y el flag `available` según `now`.
 */

import { describe, it, expect } from 'vitest';
import { computeDripAvailability, type OrderedLesson, type DripRule } from '../src/drip.js';

const DAY = 24 * 60 * 60 * 1000;

// Curso: módulo 0 → [L0, L1], módulo 1 → [L2].
const LESSONS: OrderedLesson[] = [
  { lessonId: 'L0', lessonIndex: 0, moduleIndex: 0 },
  { lessonId: 'L1', lessonIndex: 1, moduleIndex: 0 },
  { lessonId: 'L2', lessonIndex: 2, moduleIndex: 1 },
];

const ANCHOR = new Date('2026-01-01T00:00:00.000Z');

describe('computeDripAvailability', () => {
  it('sin reglas → mapa vacío (todo disponible)', () => {
    const map = computeDripAvailability(LESSONS, [], ANCHOR, new Date('2026-06-01T00:00:00Z'));
    expect(map.size).toBe(0);
  });

  it('intervalo por LECCIÓN: la lección i se libera en ancla + i × intervalo', () => {
    const rules: DripRule[] = [{ unit: 'LESSON', intervalDays: 7, startOffsetDays: 0 }];
    const map = computeDripAvailability(LESSONS, rules, ANCHOR, ANCHOR);
    expect(map.get('L0')!.availableAt.getTime()).toBe(ANCHOR.getTime());
    expect(map.get('L1')!.availableAt.getTime()).toBe(ANCHOR.getTime() + 7 * DAY);
    expect(map.get('L2')!.availableAt.getTime()).toBe(ANCHOR.getTime() + 14 * DAY);
  });

  it('el día 0 (lección 0, offset 0) está disponible inmediatamente; las siguientes no', () => {
    const rules: DripRule[] = [{ unit: 'LESSON', intervalDays: 7, startOffsetDays: 0 }];
    const map = computeDripAvailability(LESSONS, rules, ANCHOR, ANCHOR);
    expect(map.get('L0')!.available).toBe(true);
    expect(map.get('L1')!.available).toBe(false);
    expect(map.get('L2')!.available).toBe(false);
  });

  it('intervalo por MÓDULO: las lecciones del mismo módulo comparten fecha', () => {
    const rules: DripRule[] = [{ unit: 'MODULE', intervalDays: 7, startOffsetDays: 0 }];
    const map = computeDripAvailability(LESSONS, rules, ANCHOR, ANCHOR);
    // L0 y L1 (módulo 0) → día 0; L2 (módulo 1) → día 7.
    expect(map.get('L0')!.availableAt.getTime()).toBe(ANCHOR.getTime());
    expect(map.get('L1')!.availableAt.getTime()).toBe(ANCHOR.getTime());
    expect(map.get('L2')!.availableAt.getTime()).toBe(ANCHOR.getTime() + 7 * DAY);
  });

  it('startOffsetDays retrasa la primera unidad', () => {
    const rules: DripRule[] = [{ unit: 'LESSON', intervalDays: 7, startOffsetDays: 3 }];
    const map = computeDripAvailability(LESSONS, rules, ANCHOR, ANCHOR);
    expect(map.get('L0')!.availableAt.getTime()).toBe(ANCHOR.getTime() + 3 * DAY);
    expect(map.get('L2')!.availableAt.getTime()).toBe(ANCHOR.getTime() + (3 + 14) * DAY);
  });

  it('gana el MÁS PERMISIVO: con dos reglas, la fecha más temprana por lección', () => {
    const rules: DripRule[] = [
      { unit: 'LESSON', intervalDays: 30, startOffsetDays: 0 }, // lento
      { unit: 'LESSON', intervalDays: 7, startOffsetDays: 0 }, // rápido
    ];
    const map = computeDripAvailability(LESSONS, rules, ANCHOR, ANCHOR);
    // L2: min(60d, 14d) = 14d.
    expect(map.get('L2')!.availableAt.getTime()).toBe(ANCHOR.getTime() + 14 * DAY);
  });

  it('available refleja la fecha "now": a +10 días, L0 y L1 (7d) abiertas, L2 (14d) no', () => {
    const rules: DripRule[] = [{ unit: 'LESSON', intervalDays: 7, startOffsetDays: 0 }];
    const now = new Date(ANCHOR.getTime() + 10 * DAY);
    const map = computeDripAvailability(LESSONS, rules, ANCHOR, now);
    expect(map.get('L0')!.available).toBe(true);
    expect(map.get('L1')!.available).toBe(true);
    expect(map.get('L2')!.available).toBe(false);
  });
});
