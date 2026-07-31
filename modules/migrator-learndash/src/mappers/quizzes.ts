/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { LdQuiz, LdQuestion } from '../connector/index.js';
import type {
  CanonicalAssessment,
  CanonicalQuestion,
  CanonicalQuestionOption,
  MapResult,
} from './canonical.js';
import {
  externalId,
  unwrapTitle,
  decodeHtmlEntities,
  asNumber,
  mapLdQuestionType,
} from './helpers.js';

export function mapQuiz(raw: LdQuiz): MapResult<CanonicalAssessment> {
  const warnings: string[] = [];
  if (!raw || typeof raw.id !== 'number') {
    return { ok: false, errorCode: 'MALFORMED_PAYLOAD', errorMessage: 'quiz sin id', warnings };
  }
  const courseId = asNumber(raw.course);
  const lessonId = asNumber(raw.lesson);
  const topicId = asNumber(raw.topic);

  if (!courseId && !lessonId && !topicId) {
    warnings.push(`quiz ${raw.id} sin curso/lección/tema padre — quedará huérfano`);
  }
  const title = decodeHtmlEntities(unwrapTitle(raw.title));
  const certId = asNumber(raw.certificate);

  return {
    ok: true,
    warnings,
    canonical: {
      externalId: externalId(raw.id),
      sourceId: String(raw.id),
      parentCourseSourceId: courseId ? String(courseId) : undefined,
      parentLessonSourceId: lessonId ? String(lessonId) : undefined,
      parentTopicSourceId: topicId ? String(topicId) : undefined,
      title: title || `Quiz ${raw.id}`,
      passingPercentage: asNumber(raw.passingpercentage),
      threshold: asNumber(raw.threshold),
      certificateSourceId: certId && certId !== 0 ? String(certId) : undefined,
    },
  };
}

/**
 * Normaliza el `_answerData` de una question LearnDash a opciones canónicas.
 * El payload de LearnDash es notoriamente inconsistente:
 * - A veces es array de objetos `{ _answer, _correct, _points, _html }`.
 * - A veces viene serializado en PHP (string) — no se pretende parsearlo aquí.
 * - A veces es objeto indexado por número.
 *
 * Si no se puede normalizar, devolvemos array vacío y warning. La pregunta
 * se carga sin opciones (el formador podrá completarla manualmente desde
 * el panel de assessments).
 */
export function normalizeAnswerData(raw: unknown, warnings: string[]): CanonicalQuestionOption[] {
  if (!raw) return [];
  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === 'object') {
    entries = Object.values(raw as Record<string, unknown>);
  } else if (typeof raw === 'string') {
    warnings.push('answerData es string serializado (PHP); opciones se omiten');
    return [];
  } else {
    warnings.push(`answerData con tipo inesperado: ${typeof raw}`);
    return [];
  }

  const options: CanonicalQuestionOption[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const text =
      (typeof o['_answer'] === 'string' && o['_answer']) ||
      (typeof o['answer'] === 'string' && o['answer']) ||
      (typeof o['text'] === 'string' && o['text']) ||
      '';
    if (!text) continue;
    const isCorrect =
      o['_correct'] === true ||
      o['correct'] === true ||
      o['_correct'] === 1 ||
      o['_correct'] === '1';
    const points = asNumber(o['_points'] ?? o['points']);
    const feedbackHtml =
      (typeof o['_html'] === 'string' && o['_html']) ||
      (typeof o['feedback'] === 'string' && o['feedback']) ||
      undefined;
    options.push({ text, isCorrect, points, feedbackHtml });
  }
  return options;
}

export function mapQuestion(raw: LdQuestion): MapResult<CanonicalQuestion> {
  const warnings: string[] = [];
  if (!raw || typeof raw.id !== 'number') {
    return { ok: false, errorCode: 'MALFORMED_PAYLOAD', errorMessage: 'pregunta sin id', warnings };
  }
  const quizId = asNumber(raw.quiz);
  if (!quizId) {
    return {
      ok: false,
      errorCode: 'MISSING_DEPENDENCY',
      errorMessage: `pregunta ${raw.id} sin quiz padre`,
      warnings,
    };
  }
  const prompt = decodeHtmlEntities(unwrapTitle(raw.title));
  const { type, warning } = mapLdQuestionType(raw.question_type);
  if (warning) warnings.push(warning);

  const points = asNumber(raw.points) ?? 1;
  const answerData = raw.answerData ?? raw._answerData ?? raw.meta?.['_answerData'];
  const options = normalizeAnswerData(answerData, warnings);

  if ((type === 'single' || type === 'multiple') && options.length === 0) {
    warnings.push(`pregunta ${raw.id} de tipo ${type} sin opciones; se cargará vacía`);
  }

  return {
    ok: true,
    warnings,
    canonical: {
      externalId: externalId(raw.id),
      sourceId: String(raw.id),
      parentAssessmentSourceId: String(quizId),
      questionType: type,
      prompt: prompt || `Pregunta ${raw.id}`,
      points,
      options,
    },
  };
}
