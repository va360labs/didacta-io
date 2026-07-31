import { describe, expect, it } from 'vitest';
import { extractLessonText } from '../src/lesson-extractor.js';

describe('extractLessonText (LMS-90.C)', () => {
  it('TEXT con campo text → texto + título', () => {
    const r = extractLessonText({
      type: 'TEXT',
      title: 'Introducción',
      content: { text: 'Esto es la introducción al curso.' },
    });
    expect(r.text).toBe('# Introducción\n\nEsto es la introducción al curso.');
    expect(r.skipReason).toBeUndefined();
  });

  it('TEXT con campo body como fallback', () => {
    const r = extractLessonText({
      type: 'TEXT',
      title: 'X',
      content: { body: 'Contenido en body.' },
    });
    expect(r.text).toContain('Contenido en body.');
  });

  it('TEXT sin texto → skip con razón', () => {
    const r = extractLessonText({ type: 'TEXT', title: 'T', content: {} });
    expect(r.text).toBe('');
    expect(r.skipReason).toContain('TEXT lesson sin campo');
  });

  it('HTML strippea tags y decodifica entities', () => {
    const r = extractLessonText({
      type: 'HTML',
      title: 'Tema 1',
      content: {
        html: '<h2>Hola</h2><p>Esto es <strong>importante</strong> &amp; útil.</p>',
      },
    });
    expect(r.text).toContain('# Tema 1');
    expect(r.text).toContain('Hola');
    expect(r.text).toContain('importante');
    expect(r.text).toContain('& útil.');
    expect(r.text).not.toContain('<');
    expect(r.text).not.toContain('&amp;');
  });

  it('HTML con listas separa elementos', () => {
    const r = extractLessonText({
      type: 'HTML',
      title: '',
      content: { html: '<ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>' },
    });
    expect(r.text).toContain('Uno');
    expect(r.text).toContain('Dos');
    expect(r.text).toContain('Tres');
    // Sin saltos consecutivos excesivos
    expect(r.text).not.toMatch(/\n{3,}/);
  });

  it('HTML vacío tras strip → skip', () => {
    const r = extractLessonText({
      type: 'HTML',
      title: 'X',
      content: { html: '<div><span></span></div>' },
    });
    expect(r.text).toBe('');
    expect(r.skipReason).toContain('queda vacía');
  });

  // Regresión: en producción los chunks más pesados del índice eran el CSS del
  // bloque <style> que arrastró la importación de LearnDash (2026-07-30).
  it('HTML descarta el contenido de <style> y <script>, no sólo sus etiquetas', () => {
    const r = extractLessonText({
      type: 'HTML',
      title: 'Resumen',
      content: {
        html:
          '<style>:root{--clay:#CC785C;--cream:#FAF9F5;}</style>' +
          '<p>El webhook expone tu workflow como una API.</p>' +
          '<script>window.dataLayer.push({evento:"play"});</script>',
      },
    });
    expect(r.text).toContain('El webhook expone tu workflow como una API.');
    expect(r.text).not.toContain('--clay');
    expect(r.text).not.toContain('#CC785C');
    expect(r.text).not.toContain('dataLayer');
  });

  it('HTML descarta el iframe del vídeo y los comentarios', () => {
    const r = extractLessonText({
      type: 'HTML',
      title: 'Clase',
      content: {
        html:
          '<div><iframe src="https://iframe.mediadelivery.net/embed/00000/abc">fallback</iframe></div>' +
          '<!-- nota interna del importador -->' +
          '<p>Contenido de verdad.</p>',
      },
    });
    expect(r.text).toContain('Contenido de verdad.');
    expect(r.text).not.toContain('mediadelivery');
    expect(r.text).not.toContain('fallback');
    expect(r.text).not.toContain('nota interna');
  });

  it('HTML que sólo era estilos queda vacío y se salta', () => {
    const r = extractLessonText({
      type: 'HTML',
      title: 'X',
      content: { html: '<style>.a{color:red}</style>' },
    });
    expect(r.text).toBe('');
    expect(r.skipReason).toContain('queda vacía');
  });

  it('VIDEO con transcript usa la transcripción', () => {
    const r = extractLessonText({
      type: 'VIDEO',
      title: 'Demo',
      content: { videoUrl: 'https://x', transcript: 'Hablamos sobre Excel.' },
    });
    expect(r.text).toContain('# Demo');
    expect(r.text).toContain('Hablamos sobre Excel.');
  });

  it('VIDEO sin transcript usa description', () => {
    const r = extractLessonText({
      type: 'VIDEO',
      title: '',
      content: { videoUrl: 'x', description: 'Resumen del vídeo.' },
    });
    expect(r.text).toBe('Resumen del vídeo.');
  });

  it('VIDEO sin transcript ni description → skip', () => {
    const r = extractLessonText({
      type: 'VIDEO',
      title: 'V',
      content: { videoUrl: 'x' },
    });
    expect(r.text).toBe('');
    expect(r.skipReason).toContain('VIDEO sin transcript');
  });

  it('PDF con extractedText usa el texto extraído', () => {
    const r = extractLessonText({
      type: 'PDF',
      title: 'Manual',
      content: { pdfUrl: 'x.pdf', extractedText: 'Capítulo 1: introducción.' },
    });
    expect(r.text).toContain('# Manual');
    expect(r.text).toContain('Capítulo 1');
  });

  it('PDF sin texto extraído → skip', () => {
    const r = extractLessonText({
      type: 'PDF',
      title: 'M',
      content: { pdfUrl: 'x.pdf' },
    });
    expect(r.text).toBe('');
    expect(r.skipReason).toContain('OCR pendiente');
  });

  it('QUIZ siempre se omite (anti-leakage)', () => {
    const r = extractLessonText({
      type: 'QUIZ',
      title: 'Q',
      content: { quizId: '...' },
    });
    expect(r.text).toBe('');
    expect(r.skipReason).toContain('leakage');
  });

  it('SCORM se omite (caja negra)', () => {
    const r = extractLessonText({ type: 'SCORM', title: 'S', content: {} });
    expect(r.text).toBe('');
    expect(r.skipReason).toContain('caja negra');
  });

  it('TEXT con título vacío no añade prefijo', () => {
    const r = extractLessonText({
      type: 'TEXT',
      title: '',
      content: { text: 'Solo el contenido.' },
    });
    expect(r.text).toBe('Solo el contenido.');
    expect(r.text).not.toContain('#');
  });
});
