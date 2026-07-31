/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Partición del catálogo de cursos en las dos secciones que ve el alumno:
 * "Mis cursos" (donde está matriculado) y "Otros cursos de <organización>".
 *
 * Vive fuera del componente para poder testearla sin montar React: es la única
 * regla de negocio de la vista y conviene tenerla cubierta.
 *
 * Criterio de "mío": existe matrícula con estado ACTIVE o COMPLETED. Una
 * matrícula CANCELLED (baja, reembolso, expulsión del grupo) NO cuenta — el
 * curso vuelve al catálogo general, que es lo que el alumno espera ver.
 */

/** Estado de matrícula relevante para el catálogo. */
export type CatalogEnrollmentStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface CatalogEnrollmentInfo {
  status: CatalogEnrollmentStatus;
  progressPercent: number;
}

/** Estados de matrícula que hacen que un curso cuente como "mío". */
const OWNED_STATUSES: ReadonlySet<CatalogEnrollmentStatus> = new Set<CatalogEnrollmentStatus>([
  'ACTIVE',
  'COMPLETED',
]);

export function isOwnedEnrollment(info: CatalogEnrollmentInfo | undefined): boolean {
  return info !== undefined && OWNED_STATUSES.has(info.status);
}

/**
 * Reparte los cursos preservando el orden original en cada sección (el backend
 * ya los devuelve ordenados y no queremos reordenarlos por debajo).
 */
export function splitCoursesBySection<T extends { id: string }>(
  courses: readonly T[],
  enrollments: ReadonlyMap<string, CatalogEnrollmentInfo>,
): { mine: T[]; others: T[] } {
  const mine: T[] = [];
  const others: T[] = [];
  for (const course of courses) {
    if (isOwnedEnrollment(enrollments.get(course.id))) mine.push(course);
    else others.push(course);
  }
  return { mine, others };
}
