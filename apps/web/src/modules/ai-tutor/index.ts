/// Extension point del módulo `mod.ai-tutor` hacia el core.
///
/// `mod.ai-tutor` no aporta sidebar items: la única superficie es el
/// panel embebido `AiTutorPanel` (en componente core) que se monta
/// dentro de la vista de curso del alumno. El entry sigue declarándose
/// para que `filterByActiveModulesOptional` reconozca el módulo.
///
/// El client incluye también `aiProvidersApi` que sirve a múltiples
/// módulos AI (tutor, grader, content). Cuando esos otros módulos se
/// migren, podríamos extraer aiProviders a un client transversal.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const aiTutorExtension: ModuleWebExtension = {
  name: 'mod.ai-tutor',
};

export {
  aiTutorApi,
  aiProvidersApi,
  type CitationView,
  type AskResponseView,
  type IndexCourseResultView,
  type ReindexAllResultView,
  type ProviderCatalogEntry,
  type TenantProviderConfig,
  type UpsertProviderInput,
} from './client';
