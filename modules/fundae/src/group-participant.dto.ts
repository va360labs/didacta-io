/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

/**
 * DTOs de matriculación nominal de alumnos en grupo bonificable Fundae
 * (LMS-82). El service garantiza que el `userId` esté matriculado en el
 * curso vinculado a la acción del grupo (consistencia con el catálogo).
 */

export const participantStatusSchema = z.enum(['ENROLLED', 'REMOVED']);
export type ParticipantStatus = z.infer<typeof participantStatusSchema>;

export const enrollParticipantSchema = z.object({
  userId: z.string().uuid(),
  /** NIF del alumno como snapshot al matricular. Si se omite, el service
   * lo toma de `app_user.documentId` (puede ser null si el alumno no lo
   * registró aún — en ese caso el listado lo muestra como "—" hasta que
   * el admin lo edite con `update`). */
  nifAlumno: z.string().trim().min(1).max(20).optional(),
  notas: z.string().max(2000).optional(),
});
export type EnrollParticipantDto = z.infer<typeof enrollParticipantSchema>;

export const updateParticipantSchema = z.object({
  nifAlumno: z.string().trim().min(1).max(20).nullable().optional(),
  notas: z.string().max(2000).nullable().optional(),
});
export type UpdateParticipantDto = z.infer<typeof updateParticipantSchema>;

/**
 * Bulk enroll: matricula en el grupo a TODOS los `userId` que están
 * matriculados en el curso de la acción (ignorando los que ya estén en
 * el grupo). El service devuelve cuántos creó realmente.
 */
export const bulkEnrollSchema = z.object({
  /** Si se omite, se toma del courseId de la acción. Permite override
   * para casos donde varias ediciones del mismo curso comparten
   * matriculados. */
  sourceCourseId: z.string().uuid().optional(),
});
export type BulkEnrollDto = z.infer<typeof bulkEnrollSchema>;

export interface GroupParticipantView {
  id: string;
  tenantId: string;
  groupId: string;
  userId: string;
  companyId: string;
  /** Snapshot del NIF al matricular (puede divergir del actual del User). */
  nifAlumno: string | null;
  enrolledAt: string;
  removedAt: string | null;
  status: ParticipantStatus;
  notas: string | null;
  /** Snapshot del cálculo de finalización (LMS-84). Null hasta que se
   * ejecute computeCompletion con preview=false. */
  horasAsistidas: number | null;
  progressPercent: number | null;
  resultado: 'APTO' | 'NO_APTO' | 'EN_CURSO' | null;
  completedAt: string | null;
  /** Datos del User resueltos para la UI (no se persisten aquí). */
  userName: string | null;
  userEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BulkEnrollResult {
  enrolled: number;
  skipped: number;
  total: number;
}
