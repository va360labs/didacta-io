// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Segunda capa del saneado de lecciones, en el navegador.
 *
 * La frontera autoritativa es el servidor
 * (`packages/core-kernel/src/html/sanitize.ts`, con sus propios tests), pero
 * esta capa NO es decorativa: el contenido guardado antes del parche sigue
 * crudo en las bases de datos de las instalaciones existentes y sólo lo para
 * esto al pintarlo. Si aquí hay un fallo, ese XSS heredado sigue vivo.
 *
 * Hallazgo reportado por Bruno (ingenierosindustriales.com).
 * Ver SECURITY-CREDITS.md.
 */

import { describe, expect, it } from 'vitest';
import { safeExternalUrl, sanitizeLessonHtml, sanitizeRichHtml } from './sanitize-html';

describe('sanitizeLessonHtml', () => {
  it('quita el manejador onerror del reporte', () => {
    const out = sanitizeLessonHtml('<img src="x" onerror="alert(document.cookie)">');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert');
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload="alert(1)"></svg>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  ])('neutraliza %s', (input) => {
    const out = sanitizeLessonHtml(input).toLowerCase();
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onload');
    expect(out).not.toContain('srcdoc');
  });

  it.each([
    'https://www.youtube.com/embed/abc',
    'https://www.youtube-nocookie.com/embed/abc',
    'https://player.vimeo.com/video/1',
    'https://iframe.mediadelivery.net/embed/1/guid',
  ])('conserva el iframe heredado de %s', (src) => {
    const out = sanitizeLessonHtml(`<p>texto</p><iframe src="${src}"></iframe>`);
    expect(out).toContain('<iframe');
    expect(out).toContain(src);
  });

  it.each([
    ['dominio ajeno', 'https://evil.tld/embed/x'],
    ['userinfo que finge ser youtube', 'https://www.youtube.com@evil.tld/e'],
    ['sufijo que contiene el host bueno', 'https://www.youtube.com.evil.tld/e'],
  ])('elimina el iframe con %s', (_caso, src) => {
    const out = sanitizeLessonHtml(`<iframe src="${src}"></iframe>`);
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('evil.tld');
  });

  it('llamadas sucesivas no se contaminan entre sí', () => {
    // `DOMPurify.addHook` es global y el filtro de host se registra por
    // llamada; el `finally` que lo retira es lo que evita que el resultado
    // dependa del orden en que se invocan los dos saneadores. Aquí se
    // intercalan a propósito.
    const permitido = '<iframe src="https://www.youtube.com/embed/abc"></iframe>';
    const primera = sanitizeLessonHtml(permitido);
    expect(sanitizeRichHtml('<p>hola</p>')).toBe('<p>hola</p>');
    expect(sanitizeLessonHtml(permitido)).toBe(primera);
    expect(sanitizeLessonHtml('<iframe src="https://evil.tld/x"></iframe>')).not.toContain(
      '<iframe',
    );
    expect(sanitizeLessonHtml(permitido)).toBe(primera);
  });

  it('conserva el marcado normal de una lección', () => {
    const out = sanitizeLessonHtml('<h2>Tema</h2><p><strong>importante</strong></p>');
    expect(out).toContain('<h2>Tema</h2>');
    expect(out).toContain('<strong>importante</strong>');
  });
});

describe('safeExternalUrl', () => {
  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x'])(
    'rechaza %s',
    (url) => {
      expect(safeExternalUrl(url)).toBe('');
    },
  );

  it('deja pasar http(s) y rutas del propio sitio', () => {
    expect(safeExternalUrl('https://cdn.tld/a.pdf')).toContain('https://cdn.tld/a.pdf');
    expect(safeExternalUrl('/storage/file/a.pdf')).toContain('/storage/file/a.pdf');
  });
});
