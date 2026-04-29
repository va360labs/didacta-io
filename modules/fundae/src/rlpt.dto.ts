import { z } from 'zod';

/**
 * DTOs de notificaciones RLPT (LMS-80).
 *
 * El blob (PDF/escaneo) NO viaja por aquí — lo recibe el endpoint en
 * formato multipart y se persiste en Evidence Vault. Estos schemas
 * cubren sólo la metadata.
 */

export const rlptNoticeTypeSchema = z.enum([
  'NOTIFICACION_INICIAL',
  'ACUSE_RECIBO',
  'ACTA_DISCREPANCIA',
]);
export type RlptNoticeType = z.infer<typeof rlptNoticeTypeSchema>;

/**
 * Antelación mínima legal exigida por RD 694/2017 art. 4.4 para la
 * notificación inicial a la RLPT antes de iniciar un grupo Fundae.
 */
export const RLPT_ANTELACION_MINIMA_DIAS = 15;

export const createRlptNoticeSchema = z.object({
  tipo: rlptNoticeTypeSchema,
  /**
   * ISO 8601 datetime. Se mapea a fechaNotificacionAt. Si se omite, el
   * service usa `new Date()`.
   */
  fechaNotificacionAt: z
    .string()
    .datetime({
      offset: true,
      message: 'Fecha ISO 8601 con offset (ej: 2026-04-29T10:00:00+02:00)',
    })
    .optional(),
  /**
   * Plazo de vencimiento en ISO 8601. Si se omite, el service lo
   * calcula sumando RLPT_ANTELACION_MINIMA_DIAS para NOTIFICACION_INICIAL,
   * o usa la propia fechaNotificacionAt para ACUSE_RECIBO y ACTA_DISCREPANCIA.
   */
  plazoVencimientoAt: z.string().datetime({ offset: true }).optional(),
  observaciones: z.string().max(2000).optional(),
});
export type CreateRlptNoticeDto = z.infer<typeof createRlptNoticeSchema>;

export interface RlptNoticeView {
  id: string;
  tenantId: string;
  companyId: string;
  tipo: RlptNoticeType;
  fechaNotificacionAt: string;
  plazoVencimientoAt: string;
  evidenceEntryId: string;
  /** Hash SHA-256 del blob (lo expone Evidence Vault). */
  evidenceHash: string;
  /** Tamaño en bytes. */
  evidenceSize: number;
  observaciones: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
