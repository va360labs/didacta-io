import type { ModuleWebExtension } from '@/lib/module-registry';

/**
 * mod.surveys — encuestas y NPS (bloque 2). El item de sidebar cuelga del
 * grupo 'Comunidad' del área admin; el panel del alumno vive en /clase/[id].
 */
export const surveysExtension: ModuleWebExtension = {
  name: 'mod.surveys',
  sidebarItems: [
    {
      group: 'Comunidad',
      href: '/admin/encuestas',
      label: 'Encuestas',
      icon: 'chart',
      requiresRole: 'tenant_admin',
    },
  ],
};

// Convención: los consumidores importan SIEMPRE desde '@/modules/surveys',
// nunca desde './client' ni paths internos.
export {
  surveysApi,
  surveysAdminApi,
  type SessionSurveyView,
  type SurveyAnswerInput,
  type SurveyListItem,
  type SurveyQuestionResults,
  type SurveyQuestionType,
  type SurveyQuestionView,
  type SurveyResults,
} from './client';
export { SurveyPanel } from './survey-panel';
