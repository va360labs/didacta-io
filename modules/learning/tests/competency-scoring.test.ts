import { describe, expect, it } from 'vitest';
import { competencyLevel, computeCompetencyScores } from '../src/learning.service.js';

const comps = [
  { id: 'comm', name: 'Comunicación' },
  { id: 'lead', name: 'Liderazgo' },
  { id: 'tech', name: 'Conocimiento técnico' },
];

describe('computeCompetencyScores', () => {
  it('media ponderada del progreso de los cursos mapeados', () => {
    const mappings = [
      { competencyId: 'comm', courseId: 'c1', weight: 1 },
      { competencyId: 'comm', courseId: 'c2', weight: 3 },
    ];
    const progress = new Map([
      ['c1', 100],
      ['c2', 50],
    ]);
    const r = computeCompetencyScores([comps[0]!], mappings, progress);
    // (100*1 + 50*3) / (1+3) = 250/4 = 62.5 → 63
    expect(r.competencies).toEqual([{ id: 'comm', name: 'Comunicación', score: 63 }]);
    expect(r.globalScore).toBe(63);
    expect(r.globalLevel).toBe('Intermedio');
  });

  it('omite competencias sin cursos cursados (no inventa scores)', () => {
    const mappings = [
      { competencyId: 'comm', courseId: 'c1', weight: 1 },
      { competencyId: 'lead', courseId: 'c9', weight: 1 }, // c9 no cursado
    ];
    const progress = new Map([['c1', 80]]);
    const r = computeCompetencyScores(comps, mappings, progress);
    expect(r.competencies).toEqual([{ id: 'comm', name: 'Comunicación', score: 80 }]);
    expect(r.globalScore).toBe(80);
    expect(r.globalLevel).toBe('Avanzado');
  });

  it('sin competencias evaluables → vacío y nulls', () => {
    const r = computeCompetencyScores(comps, [], new Map());
    expect(r.competencies).toEqual([]);
    expect(r.globalScore).toBeNull();
    expect(r.globalLevel).toBeNull();
  });

  it('global = media de los scores por competencia', () => {
    const mappings = [
      { competencyId: 'comm', courseId: 'c1', weight: 1 },
      { competencyId: 'tech', courseId: 'c2', weight: 1 },
    ];
    const progress = new Map([
      ['c1', 90],
      ['c2', 60],
    ]);
    const r = computeCompetencyScores(comps, mappings, progress);
    expect(r.globalScore).toBe(75); // (90+60)/2
  });
});

describe('competencyLevel', () => {
  it('mapea umbrales', () => {
    expect(competencyLevel(null)).toBeNull();
    expect(competencyLevel(20)).toBe('Inicial');
    expect(competencyLevel(50)).toBe('Intermedio');
    expect(competencyLevel(80)).toBe('Avanzado');
    expect(competencyLevel(90)).toBe('Experto');
  });
});
