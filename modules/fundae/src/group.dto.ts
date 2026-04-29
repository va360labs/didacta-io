import { z } from 'zod';
import { modalidadSchema } from './dto.js';

/**
 * DTOs de grupo bonificable Fundae (LMS-81). Importes en céntimos.
 */

export const groupStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED']);
export type GroupStatus = z.infer<typeof groupStatusSchema>;

export const costTipoSchema = z.enum(['DIRECTO', 'INDIRECTO', 'ORGANIZACION']);
export type CostTipo = z.infer<typeof costTipoSchema>;

export const createGroupSchema = z.object({
  actionId: z.string().uuid(),
  companyId: z.string().uuid(),
  /** Si se omite, el service asigna `max(numeroGrupo)+1` para esa acción. */
  numeroGrupo: z.number().int().min(1).max(9999).optional(),
  modalidad: modalidadSchema,
  fechaInicioPrevista: z.string().datetime({ offset: true }),
  fechaFinPrevista: z.string().datetime({ offset: true }),
  creditoEstimadoCents: z.number().int().min(0).max(999_999_999_99).optional(),
  notas: z.string().max(2000).optional(),
});
export type CreateGroupDto = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z.object({
  modalidad: modalidadSchema.optional(),
  fechaInicioPrevista: z.string().datetime({ offset: true }).optional(),
  fechaFinPrevista: z.string().datetime({ offset: true }).optional(),
  creditoEstimadoCents: z.number().int().min(0).max(999_999_999_99).nullable().optional(),
  notas: z.string().max(2000).nullable().optional(),
});
export type UpdateGroupDto = z.infer<typeof updateGroupSchema>;

export const createCostSchema = z.object({
  tipo: costTipoSchema,
  concepto: z.string().min(1).max(200),
  amountCents: z.number().int().min(0).max(999_999_999_99),
  notas: z.string().max(2000).optional(),
});
export type CreateCostDto = z.infer<typeof createCostSchema>;

export const updateCostSchema = z.object({
  tipo: costTipoSchema.optional(),
  concepto: z.string().min(1).max(200).optional(),
  amountCents: z.number().int().min(0).max(999_999_999_99).optional(),
  notas: z.string().max(2000).nullable().optional(),
});
export type UpdateCostDto = z.infer<typeof updateCostSchema>;

export interface GroupView {
  id: string;
  tenantId: string;
  actionId: string;
  companyId: string;
  numeroGrupo: number;
  modalidad: 'PRESENCIAL' | 'TELEFORMACION' | 'MIXTA';
  fechaInicioPrevista: string;
  fechaFinPrevista: string;
  fechaInicioReal: string | null;
  fechaFinReal: string | null;
  status: GroupStatus;
  creditoEstimadoCents: number | null;
  /** Suma de costes registrados (no incluye el del crédito de la empresa). */
  creditoConsumidoCents: number;
  /** Conteo por tipo, útil para el panel de detalle. */
  costsByTipo: Record<CostTipo, number>;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CostView {
  id: string;
  tenantId: string;
  groupId: string;
  tipo: CostTipo;
  concepto: string;
  amountCents: number;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
}
