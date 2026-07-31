/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Extractor de texto plano de una lección, independiente de su tipo (LMS-90.C).
 *
 * Cada `LessonType` codifica su contenido en `content: Json` con un shape
 * distinto. El indexer necesita texto para chunkear y embeddar — esta función
 * lo aplana en un único string normalizado.
 *
 * Reglas:
 *   - VIDEO → usa `transcript` si existe; si no, `description`; si no, '' (no
 *     indexable hasta tener transcripción).
 *   - HTML → strip tags, preserva texto.
 *   - TEXT → tal cual.
 *   - PDF → usa `text` si está extraído (lo hace un job separado al subir),
 *     en caso contrario '' (sin texto, no indexable).
 *   - QUIZ → no se indexa (las preguntas no son contenido formativo de
 *     referencia para el alumno; sería leakage).
 *   - SCORM → '' (los SCORMs son cajas negras, sin texto plano accesible).
 *
 * El extractor es PURO. La obtención del content lessons-row la hace el
 * caller (indexer service); aquí sólo recibe el JSON.
 */

export type LessonType = 'VIDEO' | 'HTML' | 'PDF' | 'TEXT' | 'QUIZ' | 'SCORM';

export interface ExtractInput {
  type: LessonType;
  /** Título de la lección. Va al inicio del texto extraído como contexto. */
  title: string;
  /** content JSONB de la lección, shape variable según type. */
  content: Record<string, unknown>;
}

export interface ExtractResult {
  /** Texto plano extraído. Vacío si la lección no es indexable. */
  text: string;
  /** Razón si text vacío (para logs/telemetría del indexer). */
  skipReason?: string;
}

export function extractLessonText(input: ExtractInput): ExtractResult {
  const titleLine = input.title.trim() ? `# ${input.title.trim()}\n\n` : '';
  switch (input.type) {
    case 'TEXT': {
      const text = pickString(input.content, ['text', 'body']);
      if (!text) return { text: '', skipReason: 'TEXT lesson sin campo text/body' };
      return { text: titleLine + text };
    }
    case 'HTML': {
      const html = pickString(input.content, ['html', 'body']);
      if (!html) return { text: '', skipReason: 'HTML lesson sin campo html/body' };
      const stripped = stripHtmlTags(html);
      if (!stripped.trim()) return { text: '', skipReason: 'HTML lesson queda vacía tras strip' };
      return { text: titleLine + stripped };
    }
    case 'VIDEO': {
      // Acumulamos todas las fuentes de texto disponibles para dar el máximo
      // contexto al RAG: transcripción (lo ideal, cuando exista un pipeline que
      // la genere) + descripción + contenido complementario (html debajo del
      // vídeo) + recursos/capítulos. Sin ninguna → se salta (el vídeo por sí
      // solo no aporta texto indexable).
      const parts: string[] = [];
      const transcript = pickString(input.content, ['transcript', 'transcription']);
      if (transcript) parts.push(transcript);
      const description = pickString(input.content, ['description', 'summary']);
      if (description) parts.push(description);
      const html = pickString(input.content, ['html']);
      if (html) {
        const stripped = stripHtmlTags(html);
        if (stripped.trim()) parts.push(stripped);
      }
      const resources = pickString(input.content, ['resources']);
      if (resources.trim()) parts.push(resources);
      if (parts.length === 0) {
        return {
          text: '',
          skipReason: 'VIDEO sin transcript/description/html/resources indexable',
        };
      }
      return { text: titleLine + parts.join('\n\n') };
    }
    case 'PDF': {
      const extracted = pickString(input.content, ['extractedText', 'text']);
      if (extracted) return { text: titleLine + extracted };
      return { text: '', skipReason: 'PDF sin texto extraído (job de OCR pendiente)' };
    }
    case 'QUIZ':
      return { text: '', skipReason: 'QUIZ no se indexa (evita leakage de respuestas)' };
    case 'SCORM':
      return { text: '', skipReason: 'SCORM no es indexable (caja negra)' };
    default:
      return { text: '', skipReason: `LessonType desconocido: ${String(input.type)}` };
  }
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return '';
}

/**
 * Strip HTML tags conservando texto. Implementación intencionalmente simple
 * (no parser completo) — los HTML de lecciones vienen de un editor controlado
 * (TipTap), no de markup arbitrario.
 *
 * Pasos:
 *   1. Reemplaza <br>, <p>, <li>, <h*> con saltos de línea para preservar
 *      separación visual.
 *   2. Quita el resto de tags.
 *   3. Decodifica entidades HTML básicas.
 *   4. Colapsa whitespace excesivo.
 */
function stripHtmlTags(html: string): string {
  let text = html;
  // Bloques cuyo CONTENIDO no es texto para el alumno. Hay que borrarlos
  // enteros ANTES de quitar etiquetas: si sólo se quitan los tags, el CSS y el
  // JS quedan dentro como si fueran prosa.
  //
  // Pasó de verdad: los chunks más grandes del índice de producción eran
  // `:root{ --clay:#CC785C; … }` del bloque <style> que arrastró la
  // importación de LearnDash — 730 tokens de variables de color compitiendo
  // con el contenido real en la búsqueda por similitud (2026-07-30).
  text = text.replace(/<(style|script|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // Etiquetas vacías cuyo contenido tampoco aporta texto (iframes de vídeo,
  // svg decorativos). Sin el cierre no hay nada que borrar: cae en el strip
  // genérico de abajo.
  text = text.replace(/<(iframe|svg|canvas|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // Comentarios HTML
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Saltos de línea por bloques semánticos
  text = text.replace(/<\/?(br|p|div|h[1-6]|li|tr)[^>]*>/gi, '\n');
  // Espacio entre celdas inline
  text = text.replace(/<\/?(td|th|span|a|strong|em|b|i|u)[^>]*>/gi, ' ');
  // Strip resto de tags
  text = text.replace(/<[^>]+>/g, '');
  // Entities básicas
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Colapsar whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
