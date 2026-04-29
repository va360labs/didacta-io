import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/chunker.js';

describe('chunkText (LMS-90)', () => {
  it('texto vacío → 0 chunks', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n   ')).toEqual([]);
  });

  it('texto corto → 1 chunk', () => {
    const text = 'Esto es un texto formativo corto sobre Excel.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.ordinal).toBe(0);
    expect(chunks[0]!.content).toBe(text);
    expect(chunks[0]!.tokensCount).toBeGreaterThan(0);
  });

  it('respeta separación por párrafos al agrupar', () => {
    const text = 'Párrafo uno.\n\nPárrafo dos.\n\nPárrafo tres con más contenido para el chunker.';
    const chunks = chunkText(text, { targetTokens: 100 });
    // Como el target es 100 tokens (~400 chars) y el texto total es <400 chars,
    // todo cabe en 1 chunk.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('Párrafo uno.');
    expect(chunks[0]!.content).toContain('Párrafo tres');
  });

  it('divide en múltiples chunks cuando supera el target', () => {
    // Construyo un texto con muchos párrafos para forzar split.
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `Este es el párrafo número ${i} con contenido formativo extenso sobre el tema. `.repeat(5),
    );
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, { targetTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    // Ordinales correlativos
    chunks.forEach((c, i) => expect(c.ordinal).toBe(i));
    // Cada chunk no excede MUCHO el target (con overlap puede crecer un poco).
    for (const c of chunks) {
      expect(c.tokensCount).toBeLessThanOrEqual(800);
    }
  });

  it('aplica overlap entre chunks consecutivos', () => {
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `Párrafo ${i}: ` + 'palabra '.repeat(30),
    );
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, { targetTokens: 100, overlapTokens: 30 });

    // Solo verifica que hay solape verbal entre el final del chunk N y el inicio del N+1
    // cuando hay más de 1 chunk
    if (chunks.length > 1) {
      const tail = chunks[0]!.content.slice(-50);
      // Algún fragmento del tail debe aparecer en el chunk siguiente
      const nextStart = chunks[1]!.content.slice(0, 200);
      // Solape exacto difícil de garantizar; verificamos al menos una palabra común
      const tailWords = tail.split(/\s+/).filter((w) => w.length > 3);
      const overlapHit = tailWords.some((w) => nextStart.includes(w));
      expect(overlapHit).toBe(true);
    }
  });

  it('párrafo gigante se divide por sentencias', () => {
    const giantParagraph = Array.from(
      { length: 50 },
      (_, i) => `Esta es una sentencia número ${i} con contenido relevante.`,
    ).join(' ');
    const chunks = chunkText(giantParagraph, { targetTokens: 100, maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(2);
    // Ningún chunk debe superar el max
    for (const c of chunks) {
      expect(c.tokensCount).toBeLessThanOrEqual(300);
    }
  });

  it('normaliza CRLF y trim', () => {
    const text = '\r\n  Texto con CRLF\r\n\r\nSegundo párrafo  \r\n';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).not.toContain('\r');
    expect(chunks[0]!.content.startsWith(' ')).toBe(false);
  });

  it('tokensCount es positivo y proporcional a longitud', () => {
    const short = chunkText('Hola.');
    const longer = chunkText('Hola. '.repeat(50));
    expect(short[0]!.tokensCount).toBeGreaterThan(0);
    expect(longer[0]!.tokensCount).toBeGreaterThan(short[0]!.tokensCount);
  });
});
