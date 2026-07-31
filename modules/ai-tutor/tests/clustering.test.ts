import { describe, expect, it } from 'vitest';
import {
  clusterQuestions,
  cosineSimilarity,
  formatVector,
  parseVector,
  type ClusterableQuestion,
} from '../src/clustering.js';

/**
 * El agrupado es lo que convierte 400 preguntas sueltas en «cinco cosas que la
 * gente no entiende». Si falla, el informe mensual miente en la dirección peor:
 * enseña temas de una pregunta y esconde el que se repite.
 */

/** Vector unitario en 2D, para razonar sobre ángulos sin escribir 1536 floats. */
function dir(gradosSexagesimales: number): number[] {
  const r = (gradosSexagesimales * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

function q(text: string, embedding: number[], payload = text): ClusterableQuestion<string> {
  return { text, embedding, payload };
}

describe('cosineSimilarity', () => {
  it('vale 1 para vectores idénticos y 0 para perpendiculares', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('ignora la magnitud: solo mide ángulo', () => {
    expect(cosineSimilarity([3, 0], [0.001, 0])).toBeCloseTo(1);
  });

  it('devuelve 0 ante el vector nulo en vez de NaN', () => {
    // Un NaN aquí se propaga al orden de los temas y deja el informe sin sentido.
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe('clusterQuestions', () => {
  it('junta las formulaciones parecidas y separa las que no lo son', () => {
    const grupos = clusterQuestions(
      [
        q('no me instala el nodo', dir(0)),
        q('error al instalar el nodo', dir(4)),
        q('la instalación del nodo falla', dir(8)),
        q('cómo descargo mi certificado', dir(90)),
        q('dónde está el certificado', dir(94)),
      ],
      { threshold: 0.9 },
    );

    expect(grupos).toHaveLength(2);
    expect(grupos[0]!.members).toHaveLength(3);
    expect(grupos[1]!.members).toHaveLength(2);
  });

  it('ordena los temas de más a menos preguntado', () => {
    const grupos = clusterQuestions(
      [q('a', dir(90)), q('b', dir(0)), q('c', dir(2)), q('d', dir(4))],
      { threshold: 0.9 },
    );

    expect(grupos[0]!.members).toHaveLength(3);
    expect(grupos[1]!.members.map((m) => m.text)).toEqual(['a']);
  });

  it('el representante es el del centro del grupo, no el primero que entró', () => {
    // 'extremo' abre el grupo, pero 'medio' describe mejor al conjunto.
    const grupos = clusterQuestions(
      [q('extremo', dir(0)), q('medio', dir(5)), q('otro', dir(10))],
      { threshold: 0.9 },
    );

    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.representative.text).toBe('medio');
  });

  it('con el umbral alto no funde temas distintos', () => {
    const grupos = clusterQuestions([q('a', dir(0)), q('b', dir(30))], { threshold: 0.95 });
    expect(grupos).toHaveLength(2);
  });

  it('salta las preguntas sin embedding en vez de romper', () => {
    // Una pregunta antigua que el proveedor no pudo embeber no debe tumbar el informe.
    const grupos = clusterQuestions([q('sin vector', []), q('con vector', dir(0))]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.representative.text).toBe('con vector');
  });

  it('sin preguntas devuelve lista vacía', () => {
    expect(clusterQuestions([])).toEqual([]);
  });
});

describe('parseVector / formatVector', () => {
  it('hace ida y vuelta con el literal de pgvector', () => {
    const v = [0.1, -0.25, 3];
    expect(parseVector(formatVector(v))).toEqual(v);
  });

  it('devuelve vacío ante null, cadena vacía o basura', () => {
    expect(parseVector(null)).toEqual([]);
    expect(parseVector('')).toEqual([]);
    expect(parseVector('[]')).toEqual([]);
    expect(parseVector('[0.1,no-soy-un-numero]')).toEqual([]);
  });
});
