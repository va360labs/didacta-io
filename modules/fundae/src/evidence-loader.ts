/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PrismaClient } from '@didacta/database';
import type { LessonEvidence } from './tracking-evidence.js';

export interface LoadedEvidence {
  /** Rastro completo por alumno: TODAS las lecciones del itinerario, con o sin progreso. */
  lessonsByUser: Map<string, LessonEvidence[]>;
  /** `progressPercent` del enrollment, solo para poder comparar con la fórmula vieja. */
  progressByUser: Map<string, number>;
}

/**
 * Lee el rastro de seguimiento de un conjunto de alumnos en un curso.
 *
 * Vive suelto, fuera de los servicios, porque lo usan las TRES rutas por las que
 * salen horas hacia Fundae —el XML de la acción, el cierre del grupo y el
 * paquete de auditoría— y basta con que dos de ellas consulten distinto para
 * que el número que se comunica y la evidencia que lo acompaña se contradigan
 * delante de un inspector.
 *
 * Las lecciones que el alumno nunca abrió se devuelven igual, a cero: son el
 * denominador. Sin `courseId` (acción declarada pero todavía sin curso del aula)
 * devuelve mapas vacíos — no hay itinerario que recorrer.
 */
export async function loadLessonEvidence(
  prisma: PrismaClient,
  tenantId: string,
  courseId: string | null,
  userIds: readonly string[],
): Promise<LoadedEvidence> {
  const lessonsByUser = new Map<string, LessonEvidence[]>();
  const progressByUser = new Map<string, number>();
  if (!courseId || userIds.length === 0) return { lessonsByUser, progressByUser };

  const [lessons, enrollments] = await Promise.all([
    prisma.modCoursesLesson.findMany({
      where: { tenantId, deletedAt: null, module: { courseId, deletedAt: null } },
      select: {
        id: true,
        title: true,
        type: true,
        durationMinutes: true,
        position: true,
        module: { select: { title: true, position: true } },
      },
      orderBy: [{ module: { position: 'asc' } }, { position: 'asc' }],
    }),
    prisma.modLearningEnrollment.findMany({
      where: { tenantId, courseId, userId: { in: [...userIds] } },
      select: { id: true, userId: true, progressPercent: true },
    }),
  ]);

  for (const e of enrollments) progressByUser.set(e.userId, e.progressPercent ?? 0);

  const progressRows =
    enrollments.length === 0
      ? []
      : await prisma.modLearningProgress.findMany({
          where: { tenantId, enrollmentId: { in: enrollments.map((e) => e.id) } },
          select: {
            enrollmentId: true,
            lessonId: true,
            watchedSeconds: true,
            completed: true,
            completionSource: true,
            firstAccessedAt: true,
            lastAccessedAt: true,
            completedAt: true,
          },
        });

  const userByEnrollment = new Map(enrollments.map((e) => [e.id, e.userId]));
  const byUserLesson = new Map<string, (typeof progressRows)[number]>();
  for (const row of progressRows) {
    const userId = userByEnrollment.get(row.enrollmentId);
    if (userId) byUserLesson.set(`${userId}::${row.lessonId}`, row);
  }

  for (const userId of userIds) {
    lessonsByUser.set(
      userId,
      lessons.map((lesson, index) => {
        const p = byUserLesson.get(`${userId}::${lesson.id}`);
        return {
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          moduleTitle: lesson.module?.title ?? '',
          position: index + 1,
          type: String(lesson.type),
          durationMinutes: lesson.durationMinutes,
          watchedSeconds: p?.watchedSeconds ?? 0,
          completed: p?.completed ?? false,
          completionSource: p?.completionSource ?? null,
          firstAccessedAt: p?.firstAccessedAt ?? null,
          lastAccessedAt: p?.lastAccessedAt ?? null,
          completedAt: p?.completedAt ?? null,
        } satisfies LessonEvidence;
      }),
    );
  }

  return { lessonsByUser, progressByUser };
}
