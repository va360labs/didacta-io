/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.ai-content` hacia el core.
///
/// `mod.ai-content` no aporta sidebar items ni client HTTP en web: la
/// generación de contenido (summaries / flashcards / quizzes) se dispara
/// desde el editor de cursos del formador, que llama directamente al
/// backend con `apiFetch`. El entry sigue declarándose para que
/// `filterByActiveModulesOptional` reconozca el módulo (gating sidebar
/// si el día de mañana añadimos UI propia).

import type { ModuleWebExtension } from '@/lib/module-registry';

export const aiContentExtension: ModuleWebExtension = {
  name: 'mod.ai-content',
};
