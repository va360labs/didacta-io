// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { BUNNY_SLOT_ATTR, extractBunnyEmbeds } from './lesson-bunny-embeds';
import { sanitizeLessonHtml } from './sanitize-html';

/**
 * Vídeos de Bunny incrustados a mano en el HTML de una lección: sus `<iframe>`
 * (URL permanente, sin firma) se cambian por huecos donde la página monta el
 * reproductor que pide la URL a la API. Identificadores inventados.
 */

const LIB = '100200';
const GUID = '0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b';
const GUID_2 = '11111111-2222-4333-8444-555555555555';
const bunny = (guid: string, query = '') =>
  `https://iframe.mediadelivery.net/embed/${LIB}/${guid}${query}`;

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('extractBunnyEmbeds', () => {
  it('COMPATIBILIDAD: un HTML sin vídeos de Bunny se devuelve tal cual (el mismo string)', () => {
    const html =
      '<p>Texto</p><iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe><p>Fin</p>';
    const result = extractBunnyEmbeds(html);
    expect(result.html).toBe(html);
    expect(result.embeds).toEqual([]);
    expect(extractBunnyEmbeds('')).toEqual({ html: '', embeds: [] });
  });

  it('cambia el iframe de Bunny por un hueco y recuerda qué vídeo iba ahí', () => {
    const src = bunny(GUID, '?autoplay=false&loop=true');
    const result = extractBunnyEmbeds(
      `<p>Antes</p><iframe src="${src}" title="Clase 1" allowfullscreen></iframe><p>Después</p>`,
    );

    // `getAttribute` devuelve el `src` ya descodificado (`&`, no `&amp;`).
    expect(result.embeds).toEqual([
      { slot: 0, ref: { libraryId: LIB, guid: GUID }, src, title: 'Clase 1' },
    ]);
    const host = parse(result.html);
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelectorAll(`[${BUNNY_SLOT_ATTR}="0"]`)).toHaveLength(1);
    // El resto del contenido sigue en su sitio y en su orden.
    expect(host.textContent).toBe('AntesDespués');
    // La URL permanente ya no está en el HTML que se pinta.
    expect(result.html).not.toContain('mediadelivery.net');
  });

  it('no toca los iframes de otros proveedores que convivan en la misma lección', () => {
    const youtube = 'https://www.youtube-nocookie.com/embed/abc123';
    const result = extractBunnyEmbeds(
      `<iframe src="${youtube}"></iframe><iframe src="${bunny(GUID)}"></iframe>`,
    );
    const host = parse(result.html);
    expect(host.querySelectorAll('iframe')).toHaveLength(1);
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe(youtube);
    expect(result.embeds).toHaveLength(1);
  });

  it('varios vídeos: un hueco numerado por cada uno, en orden', () => {
    const result = extractBunnyEmbeds(
      `<iframe src="${bunny(GUID)}"></iframe><p>entre medias</p><iframe src="${bunny(GUID_2)}"></iframe>`,
    );
    expect(result.embeds.map((e) => [e.slot, e.ref.guid])).toEqual([
      [0, GUID],
      [1, GUID_2],
    ]);
    const host = parse(result.html);
    const slots = Array.from(host.querySelectorAll(`[${BUNNY_SLOT_ATTR}]`)).map((el) =>
      el.getAttribute(BUNNY_SLOT_ATTR),
    );
    expect(slots).toEqual(['0', '1']);
  });

  it('un iframe dentro de un párrafo o del envoltorio de proporción sigue encontrándose al pintar', () => {
    const result = extractBunnyEmbeds(
      `<p>Mira: <iframe src="${bunny(GUID)}"></iframe></p>` +
        `<div style="position:relative;padding-top:56.25%"><iframe src="${bunny(GUID_2)}"></iframe></div>`,
    );
    // El HTML se vuelve a parsear al pintarlo (innerHTML): el hueco es un
    // <span> para que el navegador no lo saque del párrafo.
    const host = parse(result.html);
    const first = host.querySelector(`[${BUNNY_SLOT_ATTR}="0"]`);
    expect(first?.tagName).toBe('SPAN');
    expect(first?.parentElement?.tagName).toBe('P');
    expect(host.querySelector(`[${BUNNY_SLOT_ATTR}="1"]`)?.parentElement?.tagName).toBe('DIV');
  });

  it('acepta la variante /play/ y un GUID en mayúsculas; sin título queda vacío', () => {
    const src = `https://iframe.mediadelivery.net/play/${LIB}/${GUID.toUpperCase()}`;
    const result = extractBunnyEmbeds(`<iframe src="${src}"></iframe>`);
    expect(result.embeds).toEqual([
      { slot: 0, ref: { libraryId: LIB, guid: GUID.toUpperCase() }, src, title: '' },
    ]);
  });

  it('un dominio que solo se PARECE a Bunny no se toca', () => {
    const html =
      '<iframe src="https://iframe.mediadelivery.net.evil.example/embed/1/abcdef12"></iframe>';
    expect(extractBunnyEmbeds(html)).toEqual({ html, embeds: [] });
  });

  it('SEGURIDAD: el contenido de una lección no puede colar su propio hueco', () => {
    // El hueco se crea DESPUÉS de sanear, y el saneado quita los `data-*`.
    const hostile =
      `<span ${BUNNY_SLOT_ATTR}="0" class="lesson-bunny-slot">falso</span>` +
      `<iframe src="${bunny(GUID)}"></iframe>`;
    const sanitized = sanitizeLessonHtml(hostile);
    expect(sanitized).not.toContain(BUNNY_SLOT_ATTR);

    const result = extractBunnyEmbeds(sanitized);
    const host = parse(result.html);
    const slots = host.querySelectorAll(`[${BUNNY_SLOT_ATTR}="0"]`);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.textContent).toBe('');
  });

  it('funciona sobre lo que deja el saneado real de una lección', () => {
    const sanitized = sanitizeLessonHtml(
      `<h2>Tema 1</h2><script>alert(1)</script><iframe src="${bunny(GUID, '?autoplay=true')}" onload="x()"></iframe>`,
    );
    const result = extractBunnyEmbeds(sanitized);
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]?.src).toBe(bunny(GUID, '?autoplay=true'));
    expect(result.html).not.toContain('script');
    expect(result.html).toContain('<h2>Tema 1</h2>');
  });
});
