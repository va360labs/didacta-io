/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseBunny, type BunnyRef } from './video';

/**
 * Vídeos de Bunny incrustados A MANO en el HTML de una lección.
 *
 * Muchas lecciones —sobre todo las importadas de otra plataforma— no son de
 * tipo vídeo: llevan el `<iframe>` de Bunny pegado dentro del texto. Ese iframe
 * apunta a la URL permanente, sin firma; en cuanto la academia activa la
 * autenticación por token en Bunny, deja de cargar. Para que esas lecciones
 * sigan funcionando (y queden igual de protegidas que las de tipo vídeo), cada
 * iframe de Bunny se cambia por un hueco donde la página monta el mismo
 * reproductor que usa una lección de vídeo, que pide su URL a la API.
 *
 * Los iframes de otros proveedores (YouTube, Vimeo) no se tocan.
 */

export interface BunnyHtmlEmbed {
  /** Índice del hueco dentro del HTML. */
  slot: number;
  ref: BunnyRef;
  /** `src` original del iframe: de ahí salen los parámetros del reproductor. */
  src: string;
  /** `title` original del iframe, o '' si no tenía. */
  title: string;
}

export const BUNNY_SLOT_ATTR = 'data-bunny-slot';
export const BUNNY_SLOT_CLASS = 'lesson-bunny-slot';

/**
 * Devuelve el HTML con cada iframe de Bunny sustituido por
 * `<span data-bunny-slot="N">` y la lista de vídeos que iban ahí. Si no hay
 * ninguno, devuelve el MISMO string (y la página se comporta como siempre).
 *
 * Se llama con HTML YA saneado: el hueco se crea después, así que el contenido
 * de una lección no puede colar el suyo (el saneado quita los `data-*`).
 *
 * El hueco es un `<span>` y no un `<div>` a propósito: un iframe puede venir
 * dentro de un `<p>`, y al volver a pintar el HTML el navegador sacaría un
 * `<div>` de ahí partiendo el párrafo en dos.
 */
export function extractBunnyEmbeds(html: string): { html: string; embeds: BunnyHtmlEmbed[] } {
  if (!html || !html.includes('mediadelivery.net') || typeof DOMParser === 'undefined') {
    return { html, embeds: [] };
  }
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const embeds: BunnyHtmlEmbed[] = [];
  for (const iframe of Array.from(doc.body.querySelectorAll('iframe'))) {
    const src = iframe.getAttribute('src') ?? '';
    const ref = parseBunny(src);
    if (!ref) continue;
    const slot = embeds.length;
    const placeholder = doc.createElement('span');
    placeholder.setAttribute(BUNNY_SLOT_ATTR, String(slot));
    placeholder.setAttribute('class', BUNNY_SLOT_CLASS);
    iframe.replaceWith(placeholder);
    embeds.push({ slot, ref, src, title: iframe.getAttribute('title')?.trim() ?? '' });
  }
  if (embeds.length === 0) return { html, embeds };
  return { html: doc.body.innerHTML, embeds };
}
