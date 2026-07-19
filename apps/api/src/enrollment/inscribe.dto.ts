import { z } from 'zod';

/**
 * Payload de `POST /api/v1/inscribe`. Lo envía una página de ventas externa
 * tras cobrar un curso: identifica al comprador (email + nombre) y el/los
 * curso(s) por su UUID interno (visible en el editor del curso).
 */
export const inscribeSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(200).optional(),
  /** UUID(s) del/los curso(s) comprado(s). 1..50 por llamada. */
  courseIds: z.array(z.string().uuid()).min(1).max(50),
  /** Locale opcional del usuario nuevo (ej. "es-ES"). */
  locale: z.string().min(2).max(10).optional(),
  /** Referencia del pedido/transacción en el sistema externo (para trazabilidad). */
  externalRef: z.string().trim().min(1).max(200).optional(),
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

export interface InscribeResult {
  userId: string;
  userCreated: boolean;
  enrollments: InscribeEnrollmentResult[];
}

/**
 * Payload de `POST /api/v1/inscribe/revoke`. Lo envía el sistema de ventas
 * externo cuando un pedido se reembolsa o cancela: da de baja la matrícula que
 * creó la API para ese comprador.
 */
export const revokeSchema = z.object({
  email: z.string().email().max(320),
  /** UUID(s) del/los curso(s) a dar de baja. 1..50 por llamada. */
  courseIds: z.array(z.string().uuid()).min(1).max(50),
  /** Referencia del pedido/reembolso en el sistema externo (trazabilidad). */
  externalRef: z.string().trim().min(1).max(200).optional(),
  /** Motivo libre (p. ej. "refund", "chargeback"). Va al audit log. */
  reason: z.string().trim().min(1).max(200).optional(),
});

export type RevokeDto = z.infer<typeof revokeSchema>;

/** Resultado por curso de una baja. */
export interface RevokeEnrollmentResult {
  courseId: string;
  /** REVOKED = se canceló · NOT_ENROLLED = no había matrícula viva por API. */
  status: 'REVOKED' | 'NOT_ENROLLED';
}

export interface RevokeResult {
  /** False si el email no corresponde a ningún usuario del tenant. */
  userFound: boolean;
  userId: string | null;
  revoked: RevokeEnrollmentResult[];
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
