/**
 * Modelo canónico interno: la forma "Didacta-shape" intermedia entre
 * el rawPayload de LearnDash y el destino real (mod.courses, mod.learning,
 * mod.assessments). Mantenerlo aquí desacopla los mappers de los cambios
 * en los schemas destino.
 */

export interface CanonicalUser {
  externalId: string;            // 'learndash:<id>'
  sourceId: string;
  email: string;
  username?: string;
  displayName?: string;
  registeredAt?: string;         // ISO date
  roles: string[];               // 'student' | 'instructor' | 'group_leader' | ...
}

export interface CanonicalCourse {
  externalId: string;
  sourceId: string;
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  description?: string;
  featuredMediaSourceId?: string;
  certificateSourceId?: string;
  priceType?: 'free' | 'paynow' | 'subscribe' | 'closed';
  pricing?: { amount?: number; currency?: string; priceText?: string };
  prerequisitesSourceIds: string[];
  modifiedAt?: string;
}

export interface CanonicalLearningUnit {
  externalId: string;
  sourceId: string;
  unitType: 'lesson' | 'topic';
  parentCourseSourceId: string;
  parentLessonSourceId?: string;
  title: string;
  orderIdx: number;
  contentHtml?: string;
  assignmentEnabled?: boolean;
  visibleAfterDays?: number;
  visibleAfterDate?: string;
}

export interface CanonicalAssessment {
  externalId: string;
  sourceId: string;
  parentCourseSourceId?: string;
  parentLessonSourceId?: string;
  parentTopicSourceId?: string;
  title: string;
  passingPercentage?: number;
  threshold?: number;
  certificateSourceId?: string;
}

export type CanonicalQuestionType =
  | 'single'
  | 'multiple'
  | 'free_text'
  | 'sort'
  | 'matrix'
  | 'cloze'
  | 'essay'
  | 'assessment';

export interface CanonicalQuestionOption {
  text: string;
  isCorrect?: boolean;
  points?: number;
  feedbackHtml?: string;
}

export interface CanonicalQuestion {
  externalId: string;
  sourceId: string;
  parentAssessmentSourceId: string;
  questionType: CanonicalQuestionType;
  prompt: string;
  points: number;
  options: CanonicalQuestionOption[];
  hintsHtml?: string;
  correctMessageHtml?: string;
  incorrectMessageHtml?: string;
}

export interface CanonicalGroup {
  externalId: string;
  sourceId: string;
  name: string;
  slug: string;
  description?: string;
  modelHint: 'cohort' | 'organization';   // decisión local, default 'cohort'
}

export interface CanonicalEnrollment {
  externalId: string;
  kind: 'direct' | 'group';
  userSourceId: string;
  courseSourceId?: string;        // para directas
  groupSourceId?: string;          // para de grupo
  accessFrom?: string;
  accessTo?: string;
  status: 'active' | 'expired' | 'revoked';
}

export interface CanonicalProgress {
  externalId: string;
  userSourceId: string;
  courseSourceId: string;
  stepSourceId?: string;
  status: 'not_started' | 'in_progress' | 'completed';
  completion: number;             // 0..1
  startedAt?: string;
  completedAt?: string;
}

export interface CanonicalMedia {
  externalId: string;
  sourceId: string;
  sourceUrl: string;
  mimeType?: string;
  sizeBytes?: number;
  filename?: string;
  width?: number;
  height?: number;
}

/** Resultado uniforme de un mapper. */
export type MapResult<T> =
  | { ok: true; canonical: T; warnings: string[] }
  | { ok: false; errorCode: string; errorMessage: string; warnings: string[] };
