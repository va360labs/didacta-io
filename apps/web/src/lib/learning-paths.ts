/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import type { Course } from './courses';

export type LearningPathStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type LearningPathSequenceType = 'LINEAR' | 'FLEXIBLE';
export type LearningPathEnrollmentStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface LearningPathEnrollmentInfo {
  status: LearningPathEnrollmentStatus;
  progressPercent: number;
}

/**
 * Acceso del alumno a un curso de la ruta: `enrolled` ya lo tiene, `free` se
 * le matricula al apuntarse (curso gratuito), `locked` hay que adquirirlo (o
 * todavía no está publicado). Apuntarse a la ruta no regala cursos de pago.
 */
export type LearningPathCourseAccess = 'enrolled' | 'free' | 'locked';

export interface LearningPathCourseEntry {
  id: string;
  courseId: string;
  position: number;
  /** Solo los trae la ficha del alumno; null si el curso no está publicado. */
  title?: string | null;
  slug?: string | null;
  /** null si no hay alumno al que referirlo. */
  access?: LearningPathCourseAccess | null;
}

export interface LearningPath {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  sequenceType: LearningPathSequenceType;
  status: LearningPathStatus;
  estimatedMinutes: number | null;
  courseCount: number;
  createdAt: string;
  enrollment: LearningPathEnrollmentInfo | null;
}

export interface NextStep {
  courseId: string;
  lessonId: string | null;
  courseUrl: string;
}

export interface LearningPathDetail extends LearningPath {
  nextStep: NextStep | null;
  courses: LearningPathCourseEntry[];
}

export interface LearningPathWithEnrolledAt extends LearningPath {
  enrolledAt: string;
}

export interface CreateLearningPathInput {
  title: string;
  description?: string;
  sequenceType?: LearningPathSequenceType;
}

export interface UpdateLearningPathInput {
  title?: string;
  description?: string;
  sequenceType?: LearningPathSequenceType;
  estimatedMinutes?: number;
  courses?: Array<{ courseId: string; position: number }>;
}

function withAuth(): string | undefined {
  return authStorage.getAccessToken() ?? undefined;
}

const BASE = '/api/v1/modules/learning/paths';

export function listPaths(): Promise<LearningPath[]> {
  return apiFetch<LearningPath[]>(BASE, {}, withAuth());
}

export function getPath(slug: string): Promise<LearningPathDetail> {
  return apiFetch<LearningPathDetail>(`${BASE}/${slug}`, {}, withAuth());
}

export function createPath(dto: CreateLearningPathInput): Promise<LearningPath> {
  return apiFetch<LearningPath>(BASE, { method: 'POST', body: JSON.stringify(dto) }, withAuth());
}

export function updatePath(id: string, dto: UpdateLearningPathInput): Promise<LearningPath> {
  return apiFetch<LearningPath>(
    `${BASE}/${id}`,
    { method: 'PATCH', body: JSON.stringify(dto) },
    withAuth(),
  );
}

export function publishPath(id: string): Promise<LearningPath> {
  return apiFetch<LearningPath>(`${BASE}/${id}/publish`, { method: 'POST' }, withAuth());
}

export function archivePath(id: string): Promise<LearningPath> {
  return apiFetch<LearningPath>(`${BASE}/${id}/archive`, { method: 'POST' }, withAuth());
}

export function restorePath(id: string): Promise<LearningPath> {
  return apiFetch<LearningPath>(`${BASE}/${id}/restore`, { method: 'POST' }, withAuth());
}

export interface LearningPathEnrollResult extends LearningPathEnrollmentInfo {
  /** Cursos de la ruta a los que el alumno sigue sin acceso (hay que adquirirlos). */
  coursesWithoutAccess: string[];
}

export function enrollPath(id: string): Promise<LearningPathEnrollResult> {
  return apiFetch<LearningPathEnrollResult>(`${BASE}/${id}/enroll`, { method: 'POST' }, withAuth());
}

export function cancelEnrollment(id: string): Promise<void> {
  return apiFetch<void>(`${BASE}/${id}/enroll`, { method: 'DELETE' }, withAuth());
}

export function listMyPaths(): Promise<LearningPathWithEnrolledAt[]> {
  return apiFetch<LearningPathWithEnrolledAt[]>(
    '/api/v1/modules/learning/me/paths',
    {},
    withAuth(),
  );
}

export function listPathsFormador(): Promise<LearningPath[]> {
  return apiFetch<LearningPath[]>(`${BASE}/formador`, {}, withAuth());
}
