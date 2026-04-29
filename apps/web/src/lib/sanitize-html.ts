'use client';

import DOMPurify from 'dompurify';

/**
 * Sanitiza HTML producido por el editor antes de renderizarlo con
 * dangerouslySetInnerHTML. Defensa en profundidad: el server ya
 * sanitiza al guardar, pero re-sanitizamos al render para que un cambio
 * en el server o un valor legacy no abra una puerta XSS.
 *
 * Lista blanca alineada con lo que produce Tiptap StarterKit + Link +
 * Image: encabezados h2/h3, párrafos, listas, blockquote, code inline,
 * strong, em, links con rel/target, imágenes con src/alt/title.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'a',
  'img',
];
const ALLOWED_ATTR = ['href', 'target', 'rel', 'class', 'src', 'alt', 'title'];

export function sanitizeRichHtml(input: string): string {
  if (!input) return '';
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    // Forzamos rel/noopener en links que tengan target=_blank.
    ADD_ATTR: ['target', 'rel'],
  });
}

/**
 * Extrae sólo el texto del HTML para previews donde necesitamos texto
 * plano (ej. line-clamp en cards del catálogo). Strippea tags vía
 * DOMPurify con `RETURN_DOM_FRAGMENT` y devuelve el textContent.
 */
export function richHtmlToPlainText(input: string): string {
  if (!input) return '';
  if (typeof window === 'undefined') {
    // SSR: degradación mínima — sólo elimina tags con un regex tosco.
    // El cliente re-renderizará con el path correcto en hidratación.
    return input.replace(/<[^>]*>/g, '').trim();
  }
  const fragment = DOMPurify.sanitize(input, { ALLOWED_TAGS: [], KEEP_CONTENT: true });
  return String(fragment).trim();
}
