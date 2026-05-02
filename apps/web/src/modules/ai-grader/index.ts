/// Extension point del módulo `mod.ai-grader` hacia el core.
///
/// `mod.ai-grader` no aporta sidebar items: la única superficie es la
/// vista de corrección del formador (`/formador/correcciones/:id`) que
/// usa `aiGraderApi` para sugerencias inline. El entry sigue
/// declarándose para que `filterByActiveModulesOptional` reconozca el
/// módulo.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const aiGraderExtension: ModuleWebExtension = {
  name: 'mod.ai-grader',
};

export {
  aiGraderApi,
  type RubricCriterion,
  type Rubric,
  type CriterionScore,
  type Suggestion,
  type SuggestForAttemptResult,
  type UpsertRubricInput,
} from './client';
