/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Catálogo portugués de Brasil (`pt-BR`).
 *
 * EN CONSTRUCCIÓN: mientras se traduce por tandas, los namespaces que todavía
 * no tienen JSON aquí salen del catálogo español (`...es`). Es un degradado
 * nombrado y temporal: cada tanda mueve sus namespaces de la herencia a un
 * import propio, y el índice final no hereda nada (lo exige
 * `messages-parity.test.ts`).
 */

import es from '../es';
import common from './common.json';
import errors from './errors.json';
import libShared from './libShared.json';
import modAiContent from './modAiContent.json';
import modAiGrader from './modAiGrader.json';
import modAssessments from './modAssessments.json';
import modCertificates from './modCertificates.json';
import modCommunity from './modCommunity.json';
import modMigratorLearndash from './modMigratorLearndash.json';
import modPaymentConnections from './modPaymentConnections.json';
import modSubscriptions from './modSubscriptions.json';
import modSurveys from './modSurveys.json';
import nav from './nav.json';
import shell from './shell.json';

export default {
  ...es,
  common,
  errors: {
    ...es.errors,
    ...errors,
  },
  libShared,
  modAiContent,
  modAiGrader,
  modAssessments,
  modCertificates,
  modCommunity,
  modMigratorLearndash,
  modPaymentConnections,
  modSubscriptions,
  modSurveys,
  nav,
  shell,
} as const;
