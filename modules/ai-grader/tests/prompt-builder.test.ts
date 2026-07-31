import { describe, expect, it } from 'vitest';
import {
  buildGraderPrompt,
  parseGraderResponse,
  type BuildGraderPromptInput,
} from '../src/prompt-builder.js';
import { GraderResponseParseError } from '../src/errors.js';
import type { RubricCriterionDto } from '../src/dto.js';

const baseInput: BuildGraderPromptInput = {
  questionPrompt: '¿Qué es la separación de responsabilidades?',
  studentAnswer: 'Es dividir el código en módulos cada uno con una sola responsabilidad.',
  rubricInstructions: 'Esperamos definición + ejemplo.',
  criteria: [
    { name: 'Definición', description: 'Explica qué es', weight: 5 },
    { name: 'Ejemplo', description: 'Da un ejemplo concreto', weight: 5 },
  ],
  maxScore: 10,
};

describe('buildGraderPrompt', () => {
  it('incluye los criterios numerados con peso y descripción', () => {
    const { user } = buildGraderPrompt(baseInput);
    expect(user).toContain('1. "Definición" (peso 5 ptos)');
    expect(user).toContain('2. "Ejemplo" (peso 5 ptos)');
    expect(user).toContain('Da un ejemplo concreto');
  });

  it('incluye la pregunta y la respuesta del alumno', () => {
    const { user } = buildGraderPrompt(baseInput);
    expect(user).toContain('separación de responsabilidades');
    expect(user).toContain('cada uno con una sola responsabilidad');
  });

  it('marca explícitamente respuesta vacía cuando el alumno no escribe nada', () => {
    const { user } = buildGraderPrompt({ ...baseInput, studentAnswer: '   ' });
    expect(user).toContain('(respuesta vacía)');
  });

  it('system pide JSON estricto y desautoriza Markdown', () => {
    const { system } = buildGraderPrompt(baseInput);
    expect(system).toMatch(/JSON/);
    expect(system).toMatch(/sin Markdown/);
  });

  it('user incluye el schema esperado', () => {
    const { user } = buildGraderPrompt(baseInput);
    expect(user).toContain('"perCriterion"');
    expect(user).toContain('"overallFeedback"');
  });

  it('muestra la suma de pesos vs maxScore para que el modelo no se exceda', () => {
    const { user } = buildGraderPrompt(baseInput);
    expect(user).toContain('suma de pesos = 10');
    expect(user).toContain('máximo de la pregunta = 10');
  });
});

const criteria: RubricCriterionDto[] = [
  { name: 'Claridad', description: 'Se entiende', weight: 4 },
  { name: 'Profundidad', description: 'Cubre los matices', weight: 6 },
];

describe('parseGraderResponse', () => {
  it('parsea respuesta JSON limpia y suma scores', () => {
    const raw = JSON.stringify({
      perCriterion: [
        { name: 'Claridad', score: 3, justification: 'Frases legibles' },
        { name: 'Profundidad', score: 5, justification: 'Falta un matiz' },
      ],
      overallFeedback: 'Buena respuesta, podés profundizar más en X.',
    });
    const r = parseGraderResponse(raw, criteria);
    expect(r.proposedScore).toBe(8);
    expect(r.perCriterion).toHaveLength(2);
    expect(r.perCriterion[0]?.justification).toBe('Frases legibles');
    expect(r.overallFeedback).toContain('Buena respuesta');
  });

  it('extrae el JSON aunque venga envuelto en texto', () => {
    const raw =
      'Aquí tienes la corrección:\n\n' +
      JSON.stringify({
        perCriterion: [
          { name: 'Claridad', score: 4, justification: 'Perfecto' },
          { name: 'Profundidad', score: 6, justification: 'Completo' },
        ],
        overallFeedback: 'Excelente.',
      }) +
      '\n\nEspero que ayude.';
    const r = parseGraderResponse(raw, criteria);
    expect(r.proposedScore).toBe(10);
  });

  it('extrae el JSON aunque venga en bloque ```json``` de Markdown', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        perCriterion: [
          { name: 'Claridad', score: 2, justification: 'Confusa' },
          { name: 'Profundidad', score: 1, justification: 'Superficial' },
        ],
        overallFeedback: 'Necesita revisión.',
      }) +
      '\n```';
    const r = parseGraderResponse(raw, criteria);
    expect(r.proposedScore).toBe(3);
  });

  it('trunca scores que excedan el peso del criterio', () => {
    const raw = JSON.stringify({
      perCriterion: [
        { name: 'Claridad', score: 999, justification: 'x' },
        { name: 'Profundidad', score: 100, justification: 'y' },
      ],
      overallFeedback: 'fb',
    });
    const r = parseGraderResponse(raw, criteria);
    expect(r.perCriterion[0]?.score).toBe(4); // truncado al weight
    expect(r.perCriterion[1]?.score).toBe(6);
    expect(r.proposedScore).toBe(10);
  });

  it('matchea criterios case-insensitive', () => {
    const raw = JSON.stringify({
      perCriterion: [
        { name: 'CLARIDAD', score: 3, justification: 'ok' },
        { name: 'profundidad', score: 4, justification: 'ok' },
      ],
      overallFeedback: 'fb',
    });
    const r = parseGraderResponse(raw, criteria);
    expect(r.proposedScore).toBe(7);
    // Mantiene el name canónico de la rúbrica, no el devuelto por el modelo.
    expect(r.perCriterion[0]?.name).toBe('Claridad');
  });

  it('lanza si falta un criterio en la respuesta', () => {
    const raw = JSON.stringify({
      perCriterion: [{ name: 'Claridad', score: 3, justification: 'x' }],
      overallFeedback: 'fb',
    });
    expect(() => parseGraderResponse(raw, criteria)).toThrow(GraderResponseParseError);
  });

  it('lanza si overallFeedback está vacío', () => {
    const raw = JSON.stringify({
      perCriterion: [
        { name: 'Claridad', score: 3, justification: 'x' },
        { name: 'Profundidad', score: 4, justification: 'x' },
      ],
      overallFeedback: '   ',
    });
    expect(() => parseGraderResponse(raw, criteria)).toThrow(GraderResponseParseError);
  });

  it('lanza si la respuesta no contiene ningún JSON', () => {
    expect(() => parseGraderResponse('Lo siento, no puedo ayudar.', criteria)).toThrow(
      GraderResponseParseError,
    );
  });

  it('lanza si el JSON está malformado', () => {
    expect(() => parseGraderResponse('{ "perCriterion": [', criteria)).toThrow(
      GraderResponseParseError,
    );
  });

  it('aplica score 0 sin reventar si el modelo manda número negativo', () => {
    const raw = JSON.stringify({
      perCriterion: [
        { name: 'Claridad', score: -5, justification: 'x' },
        { name: 'Profundidad', score: 2, justification: 'x' },
      ],
      overallFeedback: 'fb',
    });
    const r = parseGraderResponse(raw, criteria);
    expect(r.perCriterion[0]?.score).toBe(0);
    expect(r.proposedScore).toBe(2);
  });

  it('rellena justification vacía con marcador legible', () => {
    const raw = JSON.stringify({
      perCriterion: [
        { name: 'Claridad', score: 3, justification: '' },
        { name: 'Profundidad', score: 4, justification: 'ok' },
      ],
      overallFeedback: 'fb',
    });
    const r = parseGraderResponse(raw, criteria);
    expect(r.perCriterion[0]?.justification).toBe('(sin justificación)');
  });

  it('tolera JSON con strings que contienen llaves escapadas', () => {
    const raw = JSON.stringify({
      perCriterion: [
        { name: 'Claridad', score: 4, justification: 'Mencionó el patrón {key: value}' },
        { name: 'Profundidad', score: 6, justification: 'ok' },
      ],
      overallFeedback: 'fb',
    });
    const r = parseGraderResponse(raw, criteria);
    expect(r.proposedScore).toBe(10);
    expect(r.perCriterion[0]?.justification).toContain('{key: value}');
  });
});
