/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.assessments` hacia el core.
///
/// El catálogo `apps/web/src/modules/index.ts` importa esta constante y la
/// agrega al `moduleExtensions[]`. `mod.assessments` no aporta sidebar items
/// ni admin tabs propios — se consume desde superficies del core (formador
/// quizzes, formador correcciones, lesson-content-editor, quiz-player). El
/// entry sigue siendo necesario para que `filterByActiveModulesOptional`
/// reconozca el módulo si el día de mañana añadimos extensions.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const assessmentsExtension: ModuleWebExtension = {
  name: 'mod.assessments',
};

/// Re-exports del módulo. Los consumidores externos (componentes core que
/// actúan como wrapper) importan el cliente HTTP y los tipos desde
/// `@/modules/assessments` — nunca desde `./client` o paths internos.
export {
  assessmentsApi,
  type QuestionType,
  type QuizStatus,
  type AttemptStatus,
  type QuizSummary,
  type FormadorOption,
  type FormadorQuestion,
  type QuizFormadorView,
  type AlumnoOption,
  type AlumnoQuestion,
  type QuizAlumnoView,
  type AttemptSummary,
  type AttemptDetail,
} from './client';
