/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.ai-grader` hacia el core.
///
/// Aporta el item "Correcciones" al sidebar del formador. La página
/// `/studio/grading` lista los attempts pendientes y el detalle
/// vive en `/studio/grading/:id`.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const aiGraderExtension: ModuleWebExtension = {
  name: 'mod.ai-grader',
  sidebarItems: [
    {
      group: 'Formador',
      href: '/studio/grading',
      label: 'Correcciones',
      icon: 'check',
      requiresRole: 'formador',
    },
  ],
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
