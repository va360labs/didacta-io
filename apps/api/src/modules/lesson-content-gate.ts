/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * ¿Recibe este alumno el CONTENIDO de una lección?
 *
 * Es la regla única con la que el host decide si entrega el cuerpo de una
 * lección (vídeo, HTML, PDF…) a quien no la gestiona. La usan dos sitios que
 * no pueden divergir:
 *
 *  - `GET /modules/courses/:id`, que enmascara el `content` de las lecciones a
 *    las que el alumno no tiene derecho;
 *  - la protección de vídeo (`apps/api/src/video`), que solo firma la URL de
 *    reproducción de un vídeo si el alumno recibe el contenido de la lección
 *    donde aparece.
 *
 * Si mañana el producto añade otra forma de acceso (una lección de muestra, un
 * pase temporal), se añade AQUÍ y los dos caminos la heredan a la vez. Con la
 * regla copiada en cada sitio, el contenido y su vídeo acabarían desalineados:
 * o el alumno ve la lección sin vídeo, o se firma un vídeo de una lección que
 * no puede abrir.
 *
 * La regla no vive en este fichero: vive en mod.learning (matrícula viva, drip
 * relativo, fecha de publicación y límite del periodo de prueba). Aquí solo se
 * orquestan sus dos preguntas públicas.
 */

/** Roles que gestionan cursos y ven SIEMPRE el contenido completo (sin gating). */
export const COURSE_EDITOR_ROLES: ReadonlySet<string> = new Set([
  'super_admin',
  'tenant_admin',
  'formador',
]);

export function isCourseEditor(roles: readonly string[]): boolean {
  return roles.some((r) => COURSE_EDITOR_ROLES.has(r));
}

/** Lo mínimo de `LearningService` que necesita la regla (mockeable sin el módulo). */
export interface LessonContentGateLearning {
  hasActiveEnrollment(tenantId: string, userId: string, courseId: string): Promise<boolean>;
  getCourseAvailability(
    tenantId: string,
    userId: string,
    courseId: string,
  ): Promise<{ drip: boolean; lessons: Record<string, { available: boolean }> }>;
}

/**
 * Resultado para UN curso y UN alumno:
 *  - `none`: sin matrícula viva → no recibe el contenido de ninguna lección;
 *  - `all`: matriculado y sin gating → recibe todas;
 *  - `some`: matriculado con drip, fecha de publicación o periodo de prueba →
 *    recibe las que `isAvailable` diga.
 */
export type LessonContentGate =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'some'; isAvailable: (lessonId: string) => boolean };

/**
 * Evalúa la regla para un curso. NO comprueba que el curso esté publicado ni el
 * rol del usuario: eso lo decide quien llama (un editor no pasa por aquí).
 */
export async function resolveLessonContentGate(
  learning: LessonContentGateLearning,
  tenantId: string,
  userId: string,
  courseId: string,
): Promise<LessonContentGate> {
  const enrolled = await learning.hasActiveEnrollment(tenantId, userId, courseId);
  if (!enrolled) return { kind: 'none' };

  const availability = await learning.getCourseAvailability(tenantId, userId, courseId);
  if (!availability.drip) return { kind: 'all' };
  return {
    kind: 'some',
    // Las lecciones que no aparecen en el mapa no tienen gating: disponibles.
    isAvailable: (lessonId) => availability.lessons[lessonId]?.available !== false,
  };
}

/** ¿El resultado de la regla deja ver el contenido de esta lección? */
export function lessonContentAllowed(gate: LessonContentGate, lessonId: string): boolean {
  if (gate.kind === 'none') return false;
  if (gate.kind === 'all') return true;
  return gate.isAvailable(lessonId);
}
