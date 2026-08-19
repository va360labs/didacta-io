import { describe, expect, it } from 'vitest';
import {
  mapCourse,
  mapLesson,
  mapTopic,
  decodeHtmlEntities,
  mapQuiz,
  mapQuestion,
  mapUser,
  mapGroup,
  mapMedia,
  normalizeAnswerData,
  externalId,
  mapWpStatus,
  mapWpRoles,
  mapLdQuestionType,
} from '../../src/mappers/index.js';

describe('helpers', () => {
  it('externalId compone learndash:<id>', () => {
    expect(externalId(42)).toBe('learndash:42');
    expect(externalId('foo')).toBe('learndash:foo');
  });
  it('mapWpStatus traduce publish→published', () => {
    expect(mapWpStatus('publish')).toBe('published');
    expect(mapWpStatus('draft')).toBe('draft');
    expect(mapWpStatus('trash')).toBe('archived');
  });
  it('mapWpRoles aplica defaults', () => {
    expect(mapWpRoles(undefined)).toEqual(['student']);
    expect(mapWpRoles(['subscriber'])).toEqual(['student']);
    expect(mapWpRoles(['group_leader', 'subscriber'])).toEqual(
      expect.arrayContaining(['student', 'group_leader']),
    );
  });
  it('mapLdQuestionType cubre todos los tipos LearnDash', () => {
    expect(mapLdQuestionType('single').type).toBe('single');
    expect(mapLdQuestionType('multiple').type).toBe('multiple');
    expect(mapLdQuestionType('free_answer').type).toBe('free_text');
    expect(mapLdQuestionType('sort_answer').type).toBe('sort');
    expect(mapLdQuestionType('matrix_sort_answer').type).toBe('matrix');
    expect(mapLdQuestionType('cloze_answer').type).toBe('cloze');
    expect(mapLdQuestionType('essay').type).toBe('essay');
    expect(mapLdQuestionType('assessment_answer').type).toBe('assessment');
    const desc = mapLdQuestionType('inventado');
    expect(desc.type).toBe('single');
    expect(desc.warning).toBeDefined();
  });
});

describe('mapUser', () => {
  it('mapea usuario válido', () => {
    const result = mapUser({
      id: 1,
      email: 'foo@bar.com',
      name: 'Foo Bar',
      username: 'foo',
      roles: ['subscriber'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical.email).toBe('foo@bar.com');
      expect(result.canonical.externalId).toBe('learndash:1');
      expect(result.canonical.roles).toEqual(['student']);
    }
  });
  it('rechaza usuario sin email', () => {
    const result = mapUser({ id: 1, email: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('MISSING_EMAIL');
  });
});

describe('mapCourse', () => {
  it('decodifica entidades HTML del título', () => {
    const result = mapCourse({
      id: 24,
      slug: 'cur',
      title: { rendered: 'Programación &amp; Diseño' },
      status: 'publish',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canonical.title).toBe('Programación & Diseño');
  });
  it('genera slug si falta', () => {
    const result = mapCourse({ id: 24, slug: '', status: 'publish' });
    if (result.ok) {
      expect(result.canonical.slug).toBe('course-24');
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });
});

describe('mapLesson / mapTopic', () => {
  it('lección sin curso padre → MISSING_DEPENDENCY', () => {
    const r = mapLesson({ id: 100, slug: 'l' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('MISSING_DEPENDENCY');
  });
  it('topic sin lesson va con warning pero ok', () => {
    const r = mapTopic({ id: 200, slug: 't', course: 24 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonical.parentLessonSourceId).toBeUndefined();
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });

  it('el tema se lleva su HTML, igual que la leccion (C5)', () => {
    // mapLesson extraia `content.rendered` y mapTopic no: todos los temas
    // llegaban vacios en silencio, con el loaded_count perfecto.
    const html = '<p>El temario de verdad</p>';
    const r = mapTopic({
      id: 201,
      slug: 't',
      course: 24,
      lesson: 100,
      content: { rendered: html },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical.contentHtml).toBe(html);
  });

  it('la leccion y el tema extraen el contenido igual (mismo helper)', () => {
    const html = '<p>x</p>';
    const l = mapLesson({ id: 100, slug: 'l', course: 24, content: { rendered: html } });
    const t = mapTopic({ id: 200, slug: 't', course: 24, content: { rendered: html } });
    expect(l.ok && t.ok).toBe(true);
    if (l.ok && t.ok) expect(l.canonical.contentHtml).toBe(t.canonical.contentHtml);
  });

  it('un tema sin contenido en el origen avisa en vez de callar', () => {
    const r = mapTopic({ id: 202, slug: 't', course: 24, lesson: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes('sin contenido'))).toBe(true);
  });
});

describe('decodeHtmlEntities — entidades espanolas (L10)', () => {
  it('decodifica ntilde y acentuadas con nombre', () => {
    expect(decodeHtmlEntities('Espa&ntilde;a')).toBe('España');
    expect(decodeHtmlEntities('Dise&ntilde;o Gr&aacute;fico')).toBe('Diseño Gráfico');
    expect(decodeHtmlEntities('&Ntilde;')).toBe('Ñ');
  });

  it('sigue decodificando numericas y las de siempre', () => {
    expect(decodeHtmlEntities('a&#8211;b')).toBe('a–b');
    expect(decodeHtmlEntities('a&amp;b')).toBe('a&b');
  });

  it('una entidad que no conoce se deja cruda en vez de romper', () => {
    expect(decodeHtmlEntities('&noexiste;')).toBe('&noexiste;');
  });
});

describe('normalizeAnswerData', () => {
  it('soporta array de objetos con _answer / _correct', () => {
    const warnings: string[] = [];
    const opts = normalizeAnswerData(
      [
        { _answer: 'A', _correct: true, _points: 1 },
        { _answer: 'B', _correct: false },
      ],
      warnings,
    );
    expect(opts).toEqual([
      { text: 'A', isCorrect: true, points: 1, feedbackHtml: undefined },
      { text: 'B', isCorrect: false, points: undefined, feedbackHtml: undefined },
    ]);
  });
  it('string serializado PHP → opciones vacías + warning', () => {
    const warnings: string[] = [];
    const opts = normalizeAnswerData('a:2:{i:0;...}', warnings);
    expect(opts).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

describe('mapQuestion', () => {
  it('mapea single con opciones', () => {
    const r = mapQuestion({
      id: 500,
      slug: 'q',
      quiz: 50,
      question_type: 'single',
      points: 2,
      _answerData: [
        { _answer: 'sí', _correct: true },
        { _answer: 'no', _correct: false },
      ],
      title: { rendered: '¿Es True?' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonical.questionType).toBe('single');
      expect(r.canonical.options).toHaveLength(2);
      expect(r.canonical.points).toBe(2);
    }
  });
  it('pregunta sin quiz padre → MISSING_DEPENDENCY', () => {
    const r = mapQuestion({ id: 500, slug: 'q', question_type: 'single' });
    expect(r.ok).toBe(false);
  });
});

describe('mapQuiz / mapGroup / mapMedia', () => {
  it('mapMedia sin source_url falla', () => {
    const r = mapMedia({ id: 700 });
    expect(r.ok).toBe(false);
  });
  it('mapMedia con source_url ok', () => {
    const r = mapMedia({ id: 700, source_url: 'https://x/img.png', mime_type: 'image/png' });
    expect(r.ok).toBe(true);
  });
  it('mapGroup con título', () => {
    const r = mapGroup({ id: 77, slug: 'g', title: { rendered: 'Cohorte 2026' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical.name).toBe('Cohorte 2026');
  });
  it('mapQuiz acepta quiz huérfano con warning', () => {
    const r = mapQuiz({ id: 80, slug: 'q' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.length).toBeGreaterThan(0);
  });
});
