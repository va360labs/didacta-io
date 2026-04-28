import { describe, expect, it } from 'vitest';
import { formatDuration } from './format';

describe('formatDuration', () => {
  it('devuelve null para null/undefined', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
  });

  it('devuelve null para valores inválidos (NaN, negativos)', () => {
    expect(formatDuration(NaN)).toBeNull();
    expect(formatDuration(-5)).toBeNull();
  });

  it('formatea < 60 minutos como "X min"', () => {
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(59)).toBe('59 min');
  });

  it('formatea múltiplos exactos de 60 como "X h"', () => {
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(120)).toBe('2 h');
    expect(formatDuration(3000)).toBe('50 h'); // caso del feedback
  });

  it('formatea valores mixtos como "X h Y min"', () => {
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatDuration(125)).toBe('2 h 5 min');
    expect(formatDuration(3015)).toBe('50 h 15 min');
  });

  it('redondea a entero hacia abajo', () => {
    expect(formatDuration(45.7)).toBe('45 min');
  });
});
