import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { FundaeService } from './fundae.service.js';
export { FundaeCompanyService } from './company.service.js';
export { FundaeRlptService } from './rlpt.service.js';
export { buildActionXml } from './xml-export.js';
export { renderEvidencePdf, type EvidenceRenderInput } from './evidence-pdf.js';
export { buildPresentationZip, type ZipPackageInput } from './zip-package.js';
export {
  actionStatusSchema,
  createActionSchema,
  createBlockSchema,
  modalidadSchema,
  updateActionSchema,
  updateBlockSchema,
  type ActionStatus,
  type ActionView,
  type BlockView,
  type CreateActionDto,
  type CreateBlockDto,
  type Modalidad,
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
  FechasInvalidasError,
  FundaeError,
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
