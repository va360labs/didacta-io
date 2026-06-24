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
