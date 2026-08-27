/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
  /** Umbral de horas/progreso para considerar APTO al participante. Default 75. */
  umbralFinalizacionPct: z.number().int().min(1).max(100).optional(),
  notas: z.string().max(2000).nullable().optional(),
});
export type UpdateGroupDto = z.infer<typeof updateGroupSchema>;

export const finalizeGroupSchema = z.object({
  /** Si se omite, usa `group.umbralFinalizacionPct`. Permite override por
   * cálculos puntuales (auditoría) sin tocar la config persistida. */
  umbralOverride: z.number().int().min(1).max(100).optional(),
  /** Modo `preview`: calcula pero no persiste; útil para mostrar resultados
   * antes de confirmar. */
  preview: z.boolean().optional(),
});
export type FinalizeGroupDto = z.infer<typeof finalizeGroupSchema>;

export type ParticipantResultado = 'APTO' | 'NO_APTO' | 'EN_CURSO';

/**
 * Lo que el servidor puede DEMOSTRAR de un participante, al lado de lo que
 * calcula. Va aparte de `horasAsistidas` a propósito: quien firma la
 * bonificación tiene que poder ver, antes de firmar, cuánto de lo que va a
 * declarar se apoya en registros de interacción y cuánto en la casilla que
 * marcó el alumno. Ver `tracking-evidence.ts`.
 */
export interface ParticipantEvidenceView {
  /** De las horas asistidas, las que descansan en una autodeclaración. */
  horasSinVerificar: number;
  /** Lo que devolvía la fórmula anterior (`horas × progreso / 100`). */
  horasDeclaradasPorProgreso: number;
  segundosRegistrados: number;
  leccionesTotales: number;
  leccionesIniciadas: number;
  leccionesCompletadas: number;
  leccionesVerificadas: number;
  actividadesTotales: number;
  actividadesSuperadas: number;
  controlesTotales: number;
  controlesSuperados: number;
  pctHoras: number;
  pctActividades: number;
  pctControles: number;
  primerAccesoAt: string | null;
  ultimoAccesoAt: string | null;
}

export interface ParticipantCompletionView {
  participantId: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  nifAlumno: string | null;
  horasAsistidas: number;
  progressPercent: number;
  resultado: ParticipantResultado;
  completedAt: string | null;
  /** Ausente solo si la acción formativa no tiene curso asociado. */
  evidencia?: ParticipantEvidenceView;
}

export interface GroupCompletionResult {
  groupId: string;
  umbralAplicadoPct: number;
  totalParticipantes: number;
  aptos: number;
  noAptos: number;
  enCurso: number;
  preview: boolean;
  participants: ParticipantCompletionView[];
}

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
  /** Umbral % usado para APTO/NO_APTO en el cálculo de finalización. */
  umbralFinalizacionPct: number;
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
