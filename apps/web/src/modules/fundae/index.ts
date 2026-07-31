/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.fundae` hacia el core.
///
/// El catálogo `apps/web/src/modules/index.ts` importa esta constante y la
/// agrega al `moduleExtensions[]`. El core consume el agregado desde el
/// sidebar (filtra por módulos activos del tenant). Para añadir una nueva
/// superficie del módulo (ej. una página dedicada del formador), se
/// declara aquí — sin tocar el core.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const fundaeExtension: ModuleWebExtension = {
  name: 'mod.fundae',
  sidebarItems: [
    {
      group: 'Integraciones y API',
      href: '/admin/fundae',
      label: 'Fundae',
      icon: 'file',
      requiresRole: 'tenant_admin',
    },
  ],
};

/// Re-exports del módulo. Los consumidores externos (páginas Next del
/// core que actúan como wrapper) importan los clientes HTTP y los tipos
/// desde `@/modules/fundae` — nunca desde paths internos.
export {
  fundaeApi,
  type ActionStatus,
  type FundaeAction,
  type FundaeBlock,
  type FundaeParticipant,
  type CreateBlockInput,
  type UpdateBlockInput,
  type Modalidad,
} from './actions-client';

export {
  fundaeCompaniesApi,
  fundaeRlptApi,
  formatCents,
  fileToBase64,
  type FundaeCompany,
  type CreateCompanyInput,
  type UpdateCompanyInput,
  type DatosContacto,
  type RlptNotice,
  type RlptNoticeType,
  type UploadRlptInput,
} from './companies-client';

export {
  fundaeGroupsApi,
  fundaeGroupParticipantsApi,
  STATUS_LABELS,
  TIPO_LABELS,
  MODALIDAD_LABELS,
  type FundaeGroup,
  type FundaeCost,
  type FundaeGroupParticipant,
  type GroupStatus,
  type GroupCompletionResult,
  type ParticipantCompletionView,
  type ParticipantResultado,
  type ParticipantStatus,
  type CostTipo,
  type CreateGroupInput,
  type UpdateGroupInput,
  type CreateCostInput,
  type UpdateCostInput,
  type EnrollParticipantInput,
  type BulkEnrollResult,
} from './groups-client';
