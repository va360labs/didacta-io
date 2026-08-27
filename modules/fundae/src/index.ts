/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { FundaeService } from './fundae.service.js';
export { FundaeCompanyService } from './company.service.js';
export { FundaeRlptService } from './rlpt.service.js';
export { FundaeGroupService } from './group.service.js';
export { FundaeGroupParticipantService } from './group-participant.service.js';
export { buildActionXml } from './xml-export.js';
export {
  buildGroupStartXml,
  type BuildGroupStartXmlInput,
  type GroupParticipantSnapshot,
} from './group-xml-export.js';
export {
  buildGroupEndXml,
  type BuildGroupEndXmlInput,
  type GroupParticipantFinalSnapshot,
} from './group-end-xml-export.js';
export {
  FundaeInspectorService,
  type InspectorAccessView,
  type InspectionView,
  type InspectionParticipantView,
} from './inspector.service.js';
export { PARTICIPANT_ENROLLMENT_FILTER } from './participant-filter.js';
export {
  computeParticipantEvidence,
  type LessonEvidence,
  type ParticipantEvidence,
} from './tracking-evidence.js';
export { buildSeguimientoCsv, type SeguimientoCsvRow } from './seguimiento-csv.js';
export {
  buildAuditZip,
  buildCostsCsv,
  buildParticipantsCsv,
  type AuditZipInput,
  type CostCsvRow,
  type ParticipantCsvRow,
} from './audit-zip.js';
export { renderEvidencePdf, type EvidenceRenderInput } from './evidence-pdf.js';
export { buildPresentationZip, type ZipPackageInput } from './zip-package.js';
export {
  actionStatusSchema,
  createActionSchema,
  createBlockSchema,
  modalidadSchema,
  criterioFinalizacionSchema,
  updateActionSchema,
  updateBlockSchema,
  type ActionStatus,
  type ActionView,
  type BlockView,
  type CreateActionDto,
  type CreateBlockDto,
  type Modalidad,
  type CriterioFinalizacion,
  type UpdateActionDto,
  type UpdateBlockDto,
} from './dto.js';
export {
  createCompanySchema,
  updateCompanySchema,
  datosContactoSchema,
  type CreateCompanyDto,
  type UpdateCompanyDto,
  type CompanyView,
  type DatosContactoDto,
} from './company.dto.js';
export {
  createRlptNoticeSchema,
  rlptNoticeTypeSchema,
  RLPT_ANTELACION_MINIMA_DIAS,
  type CreateRlptNoticeDto,
  type RlptNoticeType,
  type RlptNoticeView,
} from './rlpt.dto.js';
export {
  createGroupSchema,
  updateGroupSchema,
  createCostSchema,
  updateCostSchema,
  finalizeGroupSchema,
  groupStatusSchema,
  costTipoSchema,
  type CreateGroupDto,
  type UpdateGroupDto,
  type CreateCostDto,
  type UpdateCostDto,
  type FinalizeGroupDto,
  type GroupCompletionResult,
  type GroupStatus,
  type CostTipo,
  type GroupView,
  type CostView,
  type ParticipantCompletionView,
  type ParticipantResultado,
} from './group.dto.js';
export {
  bulkEnrollSchema,
  enrollParticipantSchema,
  participantStatusSchema,
  updateParticipantSchema,
  type BulkEnrollDto,
  type BulkEnrollResult,
  type EnrollParticipantDto,
  type GroupParticipantView,
  type ParticipantStatus,
  type UpdateParticipantDto,
} from './group-participant.dto.js';
export {
  isValidSpanishTaxId,
  normalizeSpanishTaxId,
  validateSpanishTaxId,
  type TaxIdKind,
  type TaxIdValidation,
} from './spanish-tax-id.js';
export {
  ActionNotFoundError,
  ActionWithoutCourseError,
  BlockHoursExceedActionError,
  BlockNotFoundError,
  BlockOrdinalDuplicadoError,
  CodigoDuplicadoError,
  CompanyNifDuplicadoError,
  CompanyNotFoundError,
  CompanyTieneGruposActivosError,
  CourseNotInTenantError,
  RlptNotFoundError,
  RlptNotificacionInicialMissingError,
  RlptPlazoNoCumplidoError,
  GroupNotFoundError,
  GroupNumeroDuplicadoError,
  GroupTransicionInvalidaError,
  GroupCerradoError,
  CostNotFoundError,
  CreditoInsuficienteError,
  FechasInvalidasError,
  FundaeError,
  GroupParticipantDuplicadoError,
  GroupParticipantNotEnrolledInCourseError,
  GroupParticipantNotFoundError,
  GroupSinCursoError,
  ParticipantNotInActionError,
} from './errors.js';

export const fundaeModule: DidactaModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.fundae: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.fundae: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.fundae: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.fundae: onUninstall', { tenantId });
  },
};
