/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.ai-tutor` hacia el core.
///
/// La superficie del alumno es el panel embebido `AiTutorPanel` (componente
/// core) dentro de la vista de curso. La del admin es `/admin/ia/tutor`:
/// revisar qué se le pregunta al tutor, corregir lo que responde mal y ver el
/// informe mensual de temas. Cuelga de 'Contenido' y no de 'Integraciones y
/// API' a propósito — quien juzga si una respuesta es correcta es quien conoce
/// el material, no quien configura la clave de OpenAI (eso es
/// 'Proveedores de IA', que sí vive en Integraciones).
///
/// El client incluye también `aiProvidersApi` que sirve a múltiples
/// módulos AI (tutor, grader, content). Cuando esos otros módulos se
/// migren, podríamos extraer aiProviders a un client transversal.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const aiTutorExtension: ModuleWebExtension = {
  name: 'mod.ai-tutor',
  sidebarItems: [
    {
      group: 'Contenido',
      href: '/admin/ia/tutor',
      label: 'Tutor IA',
      icon: 'sparkles',
      requiresRole: 'tenant_admin',
    },
  ],
};

export {
  aiTutorApi,
  aiProvidersApi,
  aiTutorReviewApi,
  type CitationView,
  type AskResponseView,
  type CorrectionView,
  type IndexCourseResultView,
  type ListAnswersFilters,
  type ListAnswersResultView,
  type MonthlyReportView,
  type ReindexAllResultView,
  type ReportTopicView,
  type ReviewAnswerInput,
  type ReviewAnswerView,
  type ReviewStatus,
  type UpsertCorrectionInput,
  type ProviderCatalogEntry,
  type TenantProviderConfig,
  type UpsertProviderInput,
} from './client';
export { AdminTutorRevision } from './admin-revision';
export { AdminTutorCorrecciones } from './admin-correcciones';
export { AdminTutorInforme } from './admin-informe';
