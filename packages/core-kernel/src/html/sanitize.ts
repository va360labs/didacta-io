/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Saneado de HTML en el SERVIDOR — frontera autoritativa.
 *
 * Antes de esto, el HTML de las lecciones se guardaba tal cual llegaba del
 * editor y `apps/web` lo pintaba con `dangerouslySetInnerHTML`. El comentario
 * de `apps/web/src/lib/sanitize-html.ts` afirmaba que "el server ya sanitiza
 * al guardar", pero ese saneado no existía: un formador (o cualquiera con rol
 * tenant_admin / super_admin) podía almacenar `<img onerror=...>` y el payload
 * se ejecutaba en el navegador de cada alumno que abriera la lección.
 * Reportado por Bruno (ingenierosindustriales.com), ver SECURITY-CREDITS.md.
 *
 * Regla: se sanea DOS veces — aquí al guardar (frontera de servidor, la que
 * manda) y otra vez en el cliente al pintar (`apps/web/src/lib/sanitize-html.ts`).
 * El doble saneado es deliberado: si una de las dos capas se rompe o llega
 * contenido legacy anterior a este parche, la otra sigue tapando el agujero.
 *
 * Si tocas las listas de aquí, toca también las del cliente — están duplicadas
 * a propósito para no arrastrar `sanitize-html` (y sus dependencias de Node)
 * al bundle del navegador.
 */

import sanitizeHtml from 'sanitize-html';

/**
 * Etiquetas permitidas en texto enriquecido (descripciones de curso, bloques
 * de texto). Es lo que produce el editor Tiptap del panel más las tablas y
 * figuras que aparecen en contenido pegado desde Word / Google Docs.
 *
 * Todo lo que no esté aquí se descarta conservando su texto, salvo los
 * `nonTextTags` de abajo, cuyo contenido también se tira.
 */
export const RICH_TEXT_ALLOWED_TAGS: readonly string[] = [
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'mark',
  'small',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'code',
  'pre',
  'a',
  'img',
  'figure',
  'figcaption',
  'span',
  'div',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
];

/**
 * Etiquetas cuyo CONTENIDO se descarta además de la etiqueta. Sin esto,
 * `<script>alert(1)</script>` perdería el tag pero dejaría el texto
 * `alert(1)` suelto en la lección, y `<style>` podría colar CSS del atacante.
 */
const NON_TEXT_TAGS: string[] = [
  'script',
  'style',
  'textarea',
  'option',
  'noscript',
  'title',
  'template',
];

/**
 * Atributos permitidos por etiqueta. Deliberadamente NO existe `id` en la
 * entrada global: un `id` controlado por el atacante permite DOM clobbering
 * (pisar `window.<id>` y confundir a scripts de la página). `class` sí, que
 * es lo que usan los estilos del editor y `lesson-prose`.
 *
 * Ningún `on*` aparece aquí, así que `onerror` / `onload` / `onclick` se caen
 * solos: `sanitize-html` descarta cualquier atributo que no esté en la lista.
 */
const RICH_TEXT_ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  '*': ['class', 'dir', 'lang'],
  a: ['href', 'target', 'rel', 'title', 'name'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
  td: ['colspan', 'rowspan', 'align', 'valign'],
  th: ['colspan', 'rowspan', 'align', 'valign', 'scope'],
  col: ['span', 'width'],
  colgroup: ['span'],
  ol: ['start', 'type'],
  blockquote: ['cite'],
};

/** Atributos extra que sólo tienen sentido en el `<iframe>` de un vídeo. */
const IFRAME_ALLOWED_ATTRIBUTES: string[] = [
  'src',
  'width',
  'height',
  'title',
  'allow',
  'allowfullscreen',
  'frameborder',
  'loading',
  'referrerpolicy',
];

/**
 * Hosts desde los que se acepta un `<iframe>` en una lección HTML.
 *
 * Se corresponden con los proveedores que el propio player sabe reproducir
 * (`apps/web/src/lib/video.ts`): YouTube — incluido el dominio sin cookies —
 * y Bunny Stream. Vimeo se incluye porque aparece en lecciones heredadas
 * importadas de WordPress.
 *
 * `sanitize-html` compara el hostname EXACTO, así que cada subdominio va
 * listado por separado; no hay comodines que puedan derivar en un
 * `youtube.com.atacante.tld`.
 */
export const LESSON_ALLOWED_IFRAME_HOSTNAMES: readonly string[] = [
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
  'vimeo.com',
  'iframe.mediadelivery.net',
];

/**
 * Hosts adicionales que el operador de la instancia declara en
 * `LESSON_IFRAME_ALLOWED_HOSTS` (separados por coma). Existe porque una
 * academia self-host puede servir su propio reproductor y, sin esta válvula,
 * el saneado le rompería las lecciones y acabaría desactivándolo entero.
 *
 * Se lee del entorno del SERVIDOR: un formador no puede ampliarla.
 */
function extraIframeHostnames(): string[] {
  const raw = process.env['LESSON_IFRAME_ALLOWED_HOSTS'];
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Esquemas de URL aceptados. `javascript:` y `vbscript:` quedan fuera por
 * omisión, que es justo lo que impide `<a href="javascript:...">`.
 * `data:` no se acepta ni siquiera en `<img>`: un `data:image/svg+xml` puede
 * llevar script dentro y no compensa el riesgo frente a subir la imagen.
 */
const ALLOWED_SCHEMES: string[] = ['http', 'https', 'mailto', 'tel'];

export interface SanitizeHtmlOptions {
  /**
   * Permite `<iframe>` de los hosts de `LESSON_ALLOWED_IFRAME_HOSTNAMES`
   * (más los de `LESSON_IFRAME_ALLOWED_HOSTS`). Sólo lo usan las lecciones
   * de tipo HTML, que llevan el vídeo heredado embebido.
   */
  allowVideoIframes?: boolean;
}

function buildOptions(opts: SanitizeHtmlOptions): sanitizeHtml.IOptions {
  const allowIframes = opts.allowVideoIframes === true;
  const allowedTags = allowIframes
    ? [...RICH_TEXT_ALLOWED_TAGS, 'iframe']
    : [...RICH_TEXT_ALLOWED_TAGS];
  const allowedAttributes: Record<string, string[]> = { ...RICH_TEXT_ALLOWED_ATTRIBUTES };
  if (allowIframes) {
    allowedAttributes['iframe'] = IFRAME_ALLOWED_ATTRIBUTES;
  }

  return {
    allowedTags,
    allowedAttributes,
    nonTextTags: NON_TEXT_TAGS,
    allowedSchemes: ALLOWED_SCHEMES,
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    // Sin esto, `<iframe src="/algo">` esquivaría la comprobación de host.
    allowIframeRelativeUrls: false,
    allowedIframeHostnames: [...LESSON_ALLOWED_IFRAME_HOSTNAMES, ...extraIframeHostnames()],
    // `target="_blank"` sin `rel` deja al destino manipular `window.opener`.
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
    },
    disallowedTagsMode: 'discard',
    // Cuando el `src` de un `<iframe>` no pasa la comprobación de host,
    // `sanitize-html` borra el atributo pero deja el elemento vacío. No es
    // explotable —un iframe sin src es `about:blank` y nadie puede escribir
    // dentro sin script—, pero deja un hueco en la lección y esconde que el
    // contenido se ha filtrado. Se descarta el elemento entero.
    exclusiveFilter: (frame) => frame.tag === 'iframe' && !frame.attribs['src'],
  };
}

/**
 * Sanea texto enriquecido SIN `<iframe>`: descripciones de curso, textos de
 * bloque, cualquier HTML que no necesite vídeo embebido.
 *
 * Acepta `unknown` porque los DTO reciben `content` como registro arbitrario
 * y no queremos que un valor no-string reviente el guardado: se normaliza a
 * cadena vacía.
 */
export function sanitizeRichText(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  return sanitizeHtml(input, buildOptions({}));
}

/**
 * Sanea el HTML de una lección permitiendo `<iframe>` de los proveedores de
 * vídeo autorizados. Es lo que conserva vivas las lecciones heredadas que
 * llevan el vídeo embebido a mano sin abrir la puerta a un `<iframe>` que
 * apunte a cualquier sitio.
 */
export function sanitizeLessonHtml(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  return sanitizeHtml(input, buildOptions({ allowVideoIframes: true }));
}

/**
 * Deja pasar sólo URLs `http(s)` absolutas o rutas relativas del propio
 * sitio. Devuelve `''` para cualquier otra cosa.
 *
 * Hace falta porque `videoUrl` y `pdfUrl` acaban en el `src` de un `<iframe>`
 * del player. Confiar en que React bloquee `javascript:` sería confiar en un
 * detalle de implementación del framework para una frontera de seguridad.
 */
export function sanitizeExternalUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Ruta relativa (`/storage/...`): se acepta si no intenta salir con `//`
    // hacia otro host ni colar un esquema con `:`.
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes(':')) {
      return trimmed;
    }
    return '';
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return '';
  return parsed.toString();
}

/**
 * Campos del `content` de una lección que llevan HTML. El resto (`quizId`,
 * `scormEntry`, contadores…) se copia tal cual.
 */
const HTML_CONTENT_FIELDS = new Set(['html']);

/**
 * Campos del `content` que son URLs y acaban en un `src` / `href`.
 */
const URL_CONTENT_FIELDS = new Set(['videoUrl', 'pdfUrl', 'url', 'src', 'thumbnailUrl']);

/**
 * Sanea el objeto `content` de una lección antes de persistirlo.
 *
 * El `content` es un JSON libre por diseño (cada tipo de lección guarda lo
 * suyo), así que en vez de un esquema cerrado recorremos las claves conocidas
 * que acaban renderizándose. Las que no conocemos se copian sin tocar: son
 * datos, no marcado.
 *
 * Es idempotente — sanear dos veces da el mismo resultado — para que un
 * `updateLesson` que reenvía contenido ya saneado no lo degrade.
 */
export function sanitizeLessonContent(content: unknown): Record<string, unknown> {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (HTML_CONTENT_FIELDS.has(key)) {
      out[key] = sanitizeLessonHtml(value);
    } else if (URL_CONTENT_FIELDS.has(key)) {
      out[key] = sanitizeExternalUrl(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
