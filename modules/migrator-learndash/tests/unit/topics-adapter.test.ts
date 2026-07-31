import { describe, expect, it } from 'vitest';
import { adaptCanonicalToDidacta } from '../../src/index.js';

/// Tests del adapter de topics (v1.0.33+).
///
/// Contexto: hasta v1.0.32 el adapter rechazaba todos los topics con
/// `ADAPTER_TOPIC_SKIPPED` y los marcaba como `!SKIP:` en stg. Resultado:
/// 0/20 topics cargados en el primer reporte real del operador (silent skip).
///
/// v1.0.33 mapea topics como lessons planas en Didacta usando el endpoint
/// existente `lessons.upsertByExternalRef`, preservando:
///   - parent_course (obligatorio, FALLA con TOPIC_NO_PARENT_COURSE si falta)
///   - parent_lesson (opcional, viaja como `parentLessonExternalRef` hint)
///   - title, contentHtml, position derivada del sourceId numérico
///
/// LearnDash: `Course → Lesson → Topic`. Didacta es lesson-flat
/// (`Course → Module → Lesson`) → el topic queda como Lesson dentro del
/// module "General" del course. parentLessonExternalRef preserva la
/// referencia didáctica original para futuros consumers (auditoría).

describe('adaptCanonicalToDidacta · topics (v1.0.33)', () => {
  // ─────────────────────────────────────────────────────────────────────
  // Happy path: topic completo con parent_course + parent_lesson
  // ─────────────────────────────────────────────────────────────────────
  it('mapea topic con parent_course + parent_lesson como ns=lessons', () => {
    const canonical = {
      externalId: 'learndash:101',
      sourceId: '101',
      unitType: 'topic',
      parentCourseSourceId: '5',
      parentLessonSourceId: '42',
      title: 'Topic de ejemplo',
      contentHtml: '<p>Contenido del topic</p>',
      orderIdx: 0,
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ns).toBe('lessons');
    expect(result.input).toMatchObject({
      externalSource: 'learndash',
      externalId: '101',
      moduleExternalRef: { externalSource: 'learndash', externalId: '5' },
      type: 'HTML',
      title: 'Topic de ejemplo',
      content: { html: '<p>Contenido del topic</p>' },
    });
  });

  it('topic preserva parent_lesson como parentLessonExternalRef hint', () => {
    const canonical = {
      sourceId: '101',
      parentCourseSourceId: '5',
      parentLessonSourceId: '42',
      title: 'T',
      contentHtml: '',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['parentLessonExternalRef']).toEqual({
      externalSource: 'learndash',
      externalId: '42',
    });
  });

  it('topic sin parent_lesson NO incluye parentLessonExternalRef', () => {
    const canonical = {
      sourceId: '101',
      parentCourseSourceId: '5',
      title: 'Topic huérfano',
      contentHtml: '',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['parentLessonExternalRef']).toBeUndefined();
  });

  it('topic con sourceId numérico usa el id como position (orden estable)', () => {
    const canonical = {
      sourceId: '12345',
      parentCourseSourceId: '5',
      title: 'X',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['position']).toBe(12345);
  });

  it('topic con sourceId no-numérico cae a position=0', () => {
    const canonical = {
      sourceId: 'abc-uuid',
      parentCourseSourceId: '5',
      title: 'X',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['position']).toBe(0);
  });

  it('topic sin title usa fallback "(topic sin título · <id>)"', () => {
    const canonical = {
      sourceId: '99',
      parentCourseSourceId: '5',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['title']).toBe('(topic sin título · 99)');
  });

  it('topic con title vacío también usa fallback', () => {
    const canonical = {
      sourceId: '88',
      parentCourseSourceId: '5',
      title: '   ',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['title']).toBe('(topic sin título · 88)');
  });

  it('topic con contentHtml string lo conserva en content.html', () => {
    const canonical = {
      sourceId: '1',
      parentCourseSourceId: '5',
      title: 'X',
      contentHtml: '<h1>Título</h1><p>Cuerpo</p>',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['content']).toEqual({ html: '<h1>Título</h1><p>Cuerpo</p>' });
  });

  it('topic con contentHtml ausente cae a content.html=""', () => {
    const canonical = {
      sourceId: '1',
      parentCourseSourceId: '5',
      title: 'X',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['content']).toEqual({ html: '' });
  });

  it('topic con contentHtml no-string (objeto/null) cae a html=""', () => {
    const canonical = {
      sourceId: '1',
      parentCourseSourceId: '5',
      title: 'X',
      contentHtml: { rendered: '<p>x</p>' } as unknown,
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['content']).toEqual({ html: '' });
  });

  it('topic siempre va a ns=lessons (mismo endpoint del host)', () => {
    const canonical = {
      sourceId: '1',
      parentCourseSourceId: '5',
      title: 'X',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ns).toBe('lessons');
  });

  it('topic siempre lleva type=HTML (LearnDash topics son markup)', () => {
    const canonical = {
      sourceId: '1',
      parentCourseSourceId: '5',
      title: 'X',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['type']).toBe('HTML');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Failure path: parentCourseSourceId obligatorio
  // ─────────────────────────────────────────────────────────────────────
  it('topic sin parentCourseSourceId → fail con TOPIC_NO_PARENT_COURSE', () => {
    const canonical = {
      sourceId: '101',
      title: 'Topic sin curso',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOPIC_NO_PARENT_COURSE');
    expect(result.message).toMatch(/parentCourseSourceId/);
    expect(result.skip).toBeFalsy();
  });

  it('topic con parentCourseSourceId vacío → fail con TOPIC_NO_PARENT_COURSE', () => {
    const canonical = {
      sourceId: '101',
      parentCourseSourceId: '   ',
      title: 'X',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOPIC_NO_PARENT_COURSE');
  });

  it('topic sin sourceId → fail con ADAPTER_NO_SOURCE_ID (validación previa global)', () => {
    const canonical = {
      parentCourseSourceId: '5',
      title: 'X',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ADAPTER_NO_SOURCE_ID');
  });

  it('topic ya NO se rechaza con ADAPTER_TOPIC_SKIPPED (regresión 1.0.32→1.0.33)', () => {
    // En 1.0.32 cualquier topic devolvía skip=true con code ADAPTER_TOPIC_SKIPPED.
    // v1.0.33 NO debe nunca volver a ese estado.
    const canonical = {
      sourceId: '99',
      parentCourseSourceId: '5',
      title: 'Cualquier topic',
    };
    const result = adaptCanonicalToDidacta('topics', canonical);
    if (!result.ok) {
      expect(result.code).not.toBe('ADAPTER_TOPIC_SKIPPED');
    }
  });
});
