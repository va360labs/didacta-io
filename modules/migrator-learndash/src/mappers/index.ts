/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

export type {
  CanonicalUser,
  CanonicalCourse,
  CanonicalLearningUnit,
  CanonicalAssessment,
  CanonicalQuestion,
  CanonicalQuestionOption,
  CanonicalQuestionType,
  CanonicalGroup,
  CanonicalEnrollment,
  CanonicalProgress,
  CanonicalMedia,
  MapResult,
} from './canonical.js';

export {
  externalId,
  mapWpRoles,
  mapWpStatus,
  mapLdQuestionType,
  decodeHtmlEntities,
  extractWpContentHtml,
} from './helpers.js';
export { mapUser } from './users.js';
export { mapCourse } from './courses.js';
export { mapLesson, mapTopic } from './learning-units.js';
export { mapQuiz, mapQuestion, normalizeAnswerData } from './quizzes.js';
export { mapGroup, mapDirectEnrollment, mapGroupEnrollment } from './groups-enrollments.js';
export { mapMedia } from './media.js';
