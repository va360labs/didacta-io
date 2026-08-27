/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Regresión del XSS almacenado en lecciones HTML reportado por Bruno
 * (ingenierosindustriales.com) Ver SECURITY-CREDITS.md,
 * donde consta la version afectada.
 *
 * El payload del reporte era un elemento con manejador `onerror`, guardado por
 * un formador y ejecutado en el navegador de cada alumno que abriera la
 * lección. Aquí se cubre ese caso y las variantes que un filtro ingenuo deja
 * pasar (mayúsculas, atributos sin comillas, esquemas raros, iframes a
 * dominios que sólo PARECEN de vídeo).
 */

import { describe, expect, it } from 'vitest';
import {
  sanitizeExternalUrl,
  sanitizeLessonContent,
  sanitizeLessonHtml,
  sanitizeRichText,
} from '../src/html/sanitize.js';

describe('sanitizeLessonHtml · ejecución de script', () => {
  it('quita el manejador onerror del reporte y conserva la imagen', () => {
    const out = sanitizeLessonHtml('<img src="x" onerror="alert(document.cookie)">');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert');
    expect(out).toContain('<img');
  });

  it.each([
    ['<script>alert(1)</script>', 'alert(1)'],
    ['<ScRiPt>alert(1)</ScRiPt>', 'alert(1)'],
    ['<img src=x onerror=alert(1)>', 'onerror'],
    ['<img src=x OnErRoR=alert(1)>', 'onerror'],
    ['<body onload="alert(1)">hola</body>', 'onload'],
    ['<svg onload="alert(1)"></svg>', 'onload'],
    ['<a href="javascript:alert(1)">clic</a>', 'javascript:'],
    ['<a href="JaVaScRiPt:alert(1)">clic</a>', 'javascript:'],
    ['<form action="https://evil.tld"><input name="x"></form>', '<form'],
    ['<style>@import url(https://evil.tld)</style>', 'evil.tld'],
    ['<div id="attributes">clobber</div>', 'id='],
    ['<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">', 'data:'],
  ])('neutraliza %s', (input, forbidden) => {
    const out = sanitizeLessonHtml(input).toLowerCase();
    expect(out).not.toContain(forbidden.toLowerCase());
  });

  it('el contenido de <script> se descarta, no se deja como texto suelto', () => {
    // Quitar sólo la etiqueta dejaría `alert(1)` visible en la lección — feo,
    // y señal de que el saneado no entiende lo que está mirando.
    expect(sanitizeLessonHtml('<p>hola</p><script>alert(1)</script>')).toBe('<p>hola</p>');
  });
});

describe('sanitizeLessonHtml · iframes heredados', () => {
  it.each([
    'https://www.youtube.com/embed/abc123',
    'https://www.youtube-nocookie.com/embed/abc123',
    'https://player.vimeo.com/video/12345',
    'https://iframe.mediadelivery.net/embed/1234/guid-guid',
  ])('conserva el iframe de %s', (src) => {
    const out = sanitizeLessonHtml(`<iframe src="${src}" allowfullscreen></iframe>`);
    expect(out).toContain('<iframe');
    expect(out).toContain(src);
  });

  it.each([
    ['otro dominio', 'https://evil.tld/embed/x'],
    ['userinfo que finge ser youtube', 'https://www.youtube.com@evil.tld/embed/x'],
    ['subdominio que termina en el host bueno', 'https://www.youtube.com.evil.tld/embed/x'],
    ['ruta relativa', '/embed/x'],
    ['esquema javascript', 'javascript:alert(1)'],
    ['esquema data', 'data:text/html,<script>alert(1)</script>'],
  ])('elimina el iframe con %s', (_caso, src) => {
    const out = sanitizeLessonHtml(`<iframe src="${src}"></iframe>`);
    expect(out).not.toContain('evil.tld');
    expect(out).not.toContain('<iframe');
  });

  it('el texto enriquecido (descripciones) NO admite iframes ni siquiera de YouTube', () => {
    const out = sanitizeRichText('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(out).not.toContain('<iframe');
  });
});

describe('sanitizeLessonHtml · contenido legítimo', () => {
  it('conserva el marcado que produce el editor', () => {
    const input =
      '<h2>Título</h2><p><strong>negrita</strong> y <em>cursiva</em></p>' +
      '<ul><li>uno</li><li>dos</li></ul>' +
      '<a href="https://didacta.io" target="_blank">enlace</a>' +
      '<img src="https://cdn.tld/foto.png" alt="foto">';
    const out = sanitizeLessonHtml(input);
    expect(out).toContain('<h2>Título</h2>');
    expect(out).toContain('<strong>negrita</strong>');
    expect(out).toContain('<li>dos</li>');
    expect(out).toContain('https://cdn.tld/foto.png');
  });

  it('añade rel="noopener noreferrer" a los enlaces', () => {
    const out = sanitizeLessonHtml('<a href="https://didacta.io" target="_blank">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('es idempotente: sanear dos veces da lo mismo', () => {
    const input = '<p>hola <img src="https://cdn.tld/a.png" onerror="alert(1)"></p>';
    const once = sanitizeLessonHtml(input);
    expect(sanitizeLessonHtml(once)).toBe(once);
  });
});

describe('sanitizeExternalUrl', () => {
  it.each(['https://cdn.tld/a.pdf', 'http://cdn.tld/a.pdf', '/storage/file/abc.pdf'])(
    'deja pasar %s',
    (url) => {
      expect(sanitizeExternalUrl(url)).not.toBe('');
    },
  );

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.tld/x.pdf',
  ])('rechaza %s', (url) => {
    expect(sanitizeExternalUrl(url)).toBe('');
  });

  it('los valores que no son cadena no revientan el guardado', () => {
    expect(sanitizeExternalUrl(undefined)).toBe('');
    expect(sanitizeExternalUrl(42)).toBe('');
    expect(sanitizeExternalUrl(null)).toBe('');
  });
});

describe('sanitizeLessonContent', () => {
  it('sanea el html, valida las urls y deja el resto intacto', () => {
    const out = sanitizeLessonContent({
      html: '<p>ok</p><img src=x onerror=alert(1)>',
      videoUrl: 'https://www.youtube.com/watch?v=abc',
      pdfUrl: 'javascript:alert(1)',
      quizId: 'quiz-42',
      durationSeconds: 120,
    });

    expect(String(out['html'])).not.toContain('onerror');
    expect(out['videoUrl']).toContain('youtube.com');
    expect(out['pdfUrl']).toBe('');
    // Los campos que no son marcado ni URL son datos: se copian tal cual.
    expect(out['quizId']).toBe('quiz-42');
    expect(out['durationSeconds']).toBe(120);
  });

  it('un content que no es objeto se normaliza a {}', () => {
    expect(sanitizeLessonContent(null)).toEqual({});
    expect(sanitizeLessonContent('<script>alert(1)</script>')).toEqual({});
    expect(sanitizeLessonContent(['x'])).toEqual({});
  });
});
