/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Chunker de texto para indexación RAG (LMS-90).
 *
 * Estrategia: dividir por párrafos, agrupar hasta alcanzar `targetTokens`,
 * con `overlapTokens` de superposición entre chunks consecutivos para
 * preservar contexto en bordes.
 *
 * Aproximación de tokens: 1 token ≈ 4 chars en inglés/español promedio.
 * Para precisión real habría que usar tiktoken; aquí basta una aproximación
 * conservadora que evite chunks demasiado grandes para el modelo.
 */

export interface ChunkerOptions {
  /** Objetivo de tokens por chunk. Default 500. */
  targetTokens?: number;
  /** Tokens de solape entre chunks consecutivos. Default 50. */
  overlapTokens?: number;
  /** Tokens máximos absolutos por chunk (corta hard si un párrafo es enorme). Default 1500. */
  maxTokens?: number;
}

export interface Chunk {
  ordinal: number;
  content: string;
  tokensCount: number;
}

const CHARS_PER_TOKEN = 4;

export function chunkText(text: string, opts: ChunkerOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 500;
  const overlap = opts.overlapTokens ?? 50;
  const maxTokens = opts.maxTokens ?? 1500;

  const targetChars = target * CHARS_PER_TOKEN;
  const overlapChars = overlap * CHARS_PER_TOKEN;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // Divide por párrafos (líneas en blanco). Si no hay, por sentencias (. ! ?).
  const paragraphs = normalized.split(/\n\s*\n+/).filter((p) => p.trim().length > 0);

  const chunks: Chunk[] = [];
  let buffer = '';
  let ordinal = 0;

  const flush = () => {
    const content = buffer.trim();
    if (!content) return;
    chunks.push({
      ordinal: ordinal++,
      content,
      tokensCount: estimateTokens(content),
    });
  };

  for (const paragraph of paragraphs) {
    const para = paragraph.trim();

    // Si el párrafo solo es enorme, lo cortamos por sentencias.
    if (para.length > maxChars) {
      // Flush lo que tengamos antes de empezar a partir el párrafo gigante.
      flush();
      buffer = '';
      const sentences = splitIntoSentences(para);
      for (const s of sentences) {
        if ((buffer + ' ' + s).length > maxChars) {
          flush();
          buffer = takeTail(buffer, overlapChars) + ' ' + s;
        } else {
          buffer = buffer ? buffer + ' ' + s : s;
        }
      }
      // Tras procesar el párrafo gigante, flush y reset
      flush();
      buffer = takeTail(buffer, overlapChars);
      continue;
    }

    // Si añadir el párrafo nos pasa del target, flush y empezamos uno nuevo
    // con el solape del anterior.
    if (buffer && buffer.length + 2 + para.length > targetChars) {
      flush();
      buffer = takeTail(buffer, overlapChars) + '\n\n' + para;
    } else {
      buffer = buffer ? buffer + '\n\n' + para : para;
    }
  }

  flush();
  return chunks;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function takeTail(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return text;
  // Intentamos cortar por límite de palabra para no partir términos.
  const tail = text.slice(-chars);
  const firstSpace = tail.indexOf(' ');
  return firstSpace > 0 ? tail.slice(firstSpace + 1) : tail;
}

function splitIntoSentences(text: string): string[] {
  // Heurística simple: divide por puntuación final + espacio mayúscula.
  // Suficiente para texto formativo; no es 100% preciso pero basta.
  const sentences: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    current += text[i];
    if (
      i < text.length - 1 &&
      /[.!?]/.test(text[i] ?? '') &&
      text[i + 1] === ' ' &&
      /[A-ZÁÉÍÓÚÑ]/.test(text[i + 2] ?? '')
    ) {
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences.length > 0 ? sentences : [text];
}
