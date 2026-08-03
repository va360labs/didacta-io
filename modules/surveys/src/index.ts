/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export {
  POST_CLASS_QUESTIONS,
  SURVEYS_EVENT,
  SurveysService,
  type SubmitAnswerInput,
  type SurveysEventPublisher,
} from './surveys.service.js';
export {
  SurveysAlreadyRespondedError,
  SurveysError,
  SurveysInvalidAnswerError,
  SurveysSurveyClosedError,
  SurveysSurveyNotFoundError,
} from './errors.js';

/**
 * Módulo mod.surveys. La suscripción a `zoom.session.ended` NO vive aquí sino
 * en el host (`apps/api/src/modules/surveys/surveys-zoom.bridge.ts`): crear la
 * encuesta y avisar a los inscritos necesita el NotificationHub y una lectura
 * acotada de mod_zoom_live_session_registration — composición entre módulos que
 * pertenece al host (ADR-016), no al dominio de la encuesta.
 */
export function buildSurveysModule(): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.surveys: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.surveys: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.surveys: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.surveys: onUninstall', { tenantId });
    },
  };
}
