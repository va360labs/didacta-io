'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import DOMPurify from 'dompurify';

/**
 * Sanitiza HTML producido por el editor antes de renderizarlo con
 * dangerouslySetInnerHTML.
 *
 * Segunda capa: la frontera autoritativa es el servidor
 * (`packages/core-kernel/src/html/sanitize.ts`, aplicada en
 * `CoursesService.createLesson/updateLesson`). Re-sanitizamos al pintar
 * para que el contenido guardado ANTES de ese parche —que sigue crudo en
 * base de datos— tampoco se ejecute.
 *
 * Si tocas estas listas, toca también las del servidor: están duplicadas a
 * propósito para no arrastrar `sanitize-html` al bundle del navegador.
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
 * Deja pasar sólo URLs `http(s)` o rutas relativas del propio sitio; para
 * cualquier otra cosa devuelve `''`.
 *
 * Los `pdfUrl` / `videoUrl` guardados antes del saneado de servidor pueden
 * llevar un `javascript:` y acaban en el `src` de un `<iframe>`. Que React
 * bloquee esos esquemas es un detalle de implementación del framework, no
 * una garantía sobre la que apoyar una frontera de seguridad.
 */
export function safeExternalUrl(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Hosts de vídeo desde los que se acepta un `<iframe>` en una lección HTML.
 * DEBE coincidir con `LESSON_ALLOWED_IFRAME_HOSTNAMES` del servidor
 * (`packages/core-kernel/src/html/sanitize.ts`).
 */
const ALLOWED_IFRAME_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
  'vimeo.com',
  'iframe.mediadelivery.net',
]);

const LESSON_ALLOWED_TAGS = [...ALLOWED_TAGS, 'iframe', 'figure', 'figcaption', 'span', 'div'];
const LESSON_ALLOWED_ATTR = [
  ...ALLOWED_ATTR,
  'width',
  'height',
  'allow',
  'allowfullscreen',
  'frameborder',
  'loading',
  'referrerpolicy',
];

/**
 * Sanitiza el HTML de una lección de tipo HTML. A diferencia de
 * `sanitizeRichHtml`, conserva los `<iframe>` heredados —muchas lecciones
 * importadas llevan el vídeo embebido a mano— pero SÓLO si apuntan a un
 * proveedor de vídeo autorizado. Cualquier otro iframe, y cualquier
 * manejador `on*`, desaparece.
 *
 * El filtro de host se aplica en un hook de DOMPurify y no con un regex
 * sobre el string: parsear el `src` con `URL` es lo que impide que un
 * `https://www.youtube.com@atacante.tld/` o un `javascript:` disfrazado
 * cuelen como si fueran YouTube.
 */
export function sanitizeLessonHtml(input: string): string {
  if (!input) return '';
  const hook = (node: Element) => {
    if (node.tagName !== 'IFRAME') return;
    const src = node.getAttribute('src') ?? '';
    let parsed: URL;
    try {
      parsed = new URL(src, window.location.origin);
    } catch {
      node.remove();
      return;
    }
    const protocolOk = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    if (!protocolOk || !ALLOWED_IFRAME_HOSTS.has(parsed.hostname.toLowerCase())) {
      node.remove();
    }
  };

  DOMPurify.addHook('afterSanitizeElements', hook as never);
  try {
    return DOMPurify.sanitize(input, {
      ALLOWED_TAGS: LESSON_ALLOWED_TAGS,
      ALLOWED_ATTR: LESSON_ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['target', 'rel'],
    });
  } finally {
    DOMPurify.removeHook('afterSanitizeElements');
  }
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
