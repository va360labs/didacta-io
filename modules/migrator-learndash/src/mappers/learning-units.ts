/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { LdLesson, LdTopic } from '../connector/index.js';
import type { CanonicalLearningUnit, MapResult } from './canonical.js';
import { externalId, unwrapTitle, decodeHtmlEntities, asNumber } from './helpers.js';

export function mapLesson(raw: LdLesson, orderHint = 0): MapResult<CanonicalLearningUnit> {
  const warnings: string[] = [];
  if (!raw || typeof raw.id !== 'number') {
    return { ok: false, errorCode: 'MALFORMED_PAYLOAD', errorMessage: 'lección sin id', warnings };
  }
  const courseId = asNumber(raw.course);
  if (!courseId) {
    return {
      ok: false,
      errorCode: 'MISSING_DEPENDENCY',
      errorMessage: `lección ${raw.id} sin curso padre`,
      warnings,
    };
  }
  const title = decodeHtmlEntities(unwrapTitle(raw.title));
  if (!title) warnings.push(`lección ${raw.id} sin título`);

  // WP REST emite `content` como `{ rendered: '<html>...', protected: bool }`
  // (mismo shape que `title`). El mapper anterior NO lo extraía → todas las
  // lessons llegaban al adapter con `contentHtml=''` y se cargaban vacías.
  const contentObj = (raw as unknown as { content?: { rendered?: string } | string }).content;
  const contentHtml =
    typeof contentObj === 'string'
      ? contentObj
      : contentObj && typeof contentObj === 'object' && typeof contentObj.rendered === 'string'
        ? contentObj.rendered
        : '';

  const visibleAfterDays = asNumber(raw.visible_after);
  return {
    ok: true,
    warnings,
    canonical: {
      externalId: externalId(raw.id),
      sourceId: String(raw.id),
      unitType: 'lesson',
      parentCourseSourceId: String(courseId),
      title: title || `Lección ${raw.id}`,
      orderIdx: orderHint,
      contentHtml,
      assignmentEnabled: !!raw.assignment_upload_enabled,
      visibleAfterDays,
      visibleAfterDate: raw.visible_after_specific_date,
    },
  };
}

export function mapTopic(raw: LdTopic, orderHint = 0): MapResult<CanonicalLearningUnit> {
  const warnings: string[] = [];
  if (!raw || typeof raw.id !== 'number') {
    return { ok: false, errorCode: 'MALFORMED_PAYLOAD', errorMessage: 'tema sin id', warnings };
  }
  const courseId = asNumber(raw.course);
  const lessonId = asNumber(raw.lesson);
  if (!courseId) {
    return {
      ok: false,
      errorCode: 'MISSING_DEPENDENCY',
      errorMessage: `tema ${raw.id} sin curso padre`,
      warnings,
    };
  }
  if (!lessonId) {
    warnings.push(`tema ${raw.id} sin lección padre — se cargará como hijo directo del curso`);
  }
  const title = decodeHtmlEntities(unwrapTitle(raw.title));

  return {
    ok: true,
    warnings,
    canonical: {
      externalId: externalId(raw.id),
      sourceId: String(raw.id),
      unitType: 'topic',
      parentCourseSourceId: String(courseId),
      parentLessonSourceId: lessonId ? String(lessonId) : undefined,
      title: title || `Tema ${raw.id}`,
      orderIdx: orderHint,
    },
  };
}
