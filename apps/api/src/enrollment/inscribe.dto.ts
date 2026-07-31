/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

/**
 * Payload de `POST /api/v1/inscribe`. Lo envía una página de ventas externa
 * tras cobrar un curso: identifica al comprador (email + nombre) y el/los
 * curso(s) por su UUID interno (visible en el editor del curso).
 */
export const inscribeSchema = z
  .object({
    email: z.string().email().max(320),
    name: z.string().trim().min(1).max(200).optional(),
    /** UUID(s) del/los curso(s) comprado(s). Hasta 50 por llamada. */
    courseIds: z.array(z.string().uuid()).max(50).optional(),
    /**
     * UUID(s) del/los grupo(s) de acceso a los que da derecho la compra. El
     * grupo es lo que otorga visibilidad de uno o varios cursos: al asignarlo se
     * crean los grants y las matrículas de TODOS sus cursos, y la baja los
     * revoca por refcount. Es la vía recomendada para packs/membresías.
     */
    accessGroupIds: z.array(z.string().uuid()).max(20).optional(),
    /** Locale opcional del usuario nuevo (ej. "es-ES"). */
    locale: z.string().min(2).max(10).optional(),
    /** Referencia del pedido/transacción en el sistema externo (para trazabilidad). */
    externalRef: z.string().trim().min(1).max(200).optional(),
  })
  .refine((d) => (d.courseIds?.length ?? 0) > 0 || (d.accessGroupIds?.length ?? 0) > 0, {
    message: 'Indica al menos un curso (courseIds) o un grupo de acceso (accessGroupIds).',
    path: ['courseIds'],
  });

export type InscribeDto = z.infer<typeof inscribeSchema>;

/** Resultado de matriculación por curso dentro de una llamada a /inscribe. */
export interface InscribeEnrollmentResult {
  courseId: string;
  enrollmentId: string | null;
  status: 'ACTIVE' | 'FAILED';
  alreadyEnrolled: boolean;
  error?: string;
}

/** Resultado por grupo de acceso asignado en una llamada a /inscribe. */
export interface InscribeGroupResult {
  groupId: string;
  /** ASSIGNED = alta nueva · ALREADY_MEMBER = ya lo era · FAILED = grupo inválido. */
  status: 'ASSIGNED' | 'ALREADY_MEMBER' | 'FAILED';
  error?: string;
}

export interface InscribeResult {
  userId: string;
  userCreated: boolean;
  enrollments: InscribeEnrollmentResult[];
  accessGroups: InscribeGroupResult[];
}

/**
 * Payload de `POST /api/v1/inscribe/revoke`. Lo envía el sistema de ventas
 * externo cuando un pedido se reembolsa o cancela: da de baja la matrícula que
 * creó la API para ese comprador.
 */
export const revokeSchema = z
  .object({
    email: z.string().email().max(320),
    /** UUID(s) del/los curso(s) a dar de baja. Hasta 50 por llamada. */
    courseIds: z.array(z.string().uuid()).max(50).optional(),
    /**
     * UUID(s) del/los grupo(s) de acceso a retirar. Revoca los grants del grupo
     * y desmatricula por refcount (si otro grupo sigue dando el curso, se
     * conserva el acceso).
     */
    accessGroupIds: z.array(z.string().uuid()).max(20).optional(),
    /** Referencia del pedido/reembolso en el sistema externo (trazabilidad). */
    externalRef: z.string().trim().min(1).max(200).optional(),
    /** Motivo libre (p. ej. "refund", "chargeback"). Va al audit log. */
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .refine((d) => (d.courseIds?.length ?? 0) > 0 || (d.accessGroupIds?.length ?? 0) > 0, {
    message: 'Indica al menos un curso (courseIds) o un grupo de acceso (accessGroupIds).',
    path: ['courseIds'],
  });

export type RevokeDto = z.infer<typeof revokeSchema>;

/** Resultado por curso de una baja. */
export interface RevokeEnrollmentResult {
  courseId: string;
  /** REVOKED = se canceló · NOT_ENROLLED = no había matrícula viva por API. */
  status: 'REVOKED' | 'NOT_ENROLLED';
}

/** Resultado por grupo de acceso retirado en una llamada a /inscribe/revoke. */
export interface RevokeGroupResult {
  groupId: string;
  /** REVOKED = se retiró · NOT_MEMBER = no era miembro activo · FAILED = grupo inválido. */
  status: 'REVOKED' | 'NOT_MEMBER' | 'FAILED';
  error?: string;
}

export interface RevokeResult {
  /** False si el email no corresponde a ningún usuario del tenant. */
  userFound: boolean;
  userId: string | null;
  revoked: RevokeEnrollmentResult[];
  accessGroups: RevokeGroupResult[];
}

/** Grupo de acceso tal y como lo ve la integración externa. */
export interface ApiAccessGroupSummary {
  id: string;
  name: string;
  /** ALL_COURSES | COURSE | MULTI_COURSE. */
  kind: string;
  /** Nº de cursos que otorga (para ALL_COURSES es el total publicado). */
  courseCount: number;
}

/** Curso tal y como lo ve la integración externa (para mapear producto → curso). */
export interface ApiCourseSummary {
  id: string;
  title: string;
  slug: string;
  /** DRAFT | PUBLISHED | ARCHIVED. Solo los PUBLISHED admiten matrícula. */
  status: string;
  category: string | null;
  publishedAt: string | null;
}
