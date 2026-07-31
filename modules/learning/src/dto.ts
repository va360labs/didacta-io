/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

export const enrollByAdminSchema = z.object({
  userId: z.string().uuid(),
  courseId: z.string().uuid(),
});
export type EnrollByAdminDto = z.infer<typeof enrollByAdminSchema>;

export const enrollByCodeSchema = z.object({
  code: z.string().min(4).max(40),
});
export type EnrollByCodeDto = z.infer<typeof enrollByCodeSchema>;

export const enrollByLinkSchema = z.object({
  token: z.string().min(8),
});
export type EnrollByLinkDto = z.infer<typeof enrollByLinkSchema>;

/** El alumno se matricula a sí mismo. Solo requiere el curso. */
export const enrollSelfSchema = z.object({
  courseId: z.string().uuid(),
});
export type EnrollSelfDto = z.infer<typeof enrollSelfSchema>;

/** Listar invitaciones activas de un curso (para que el formador las gestione). */
export const listInvitationsQuerySchema = z.object({
  courseId: z.string().uuid(),
});
export type ListInvitationsQueryDto = z.infer<typeof listInvitationsQuerySchema>;

export const trackProgressSchema = z.object({
  enrollmentId: z.string().uuid(),
  lessonId: z.string().uuid(),
  watchedSeconds: z.number().int().min(0),
  resumePositionSec: z.number().int().min(0).optional(),
  completed: z.boolean().optional(),
});
export type TrackProgressDto = z.infer<typeof trackProgressSchema>;

export const createInvitationSchema = z.object({
  courseId: z.string().uuid(),
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});
export type CreateInvitationDto = z.infer<typeof createInvitationSchema>;
