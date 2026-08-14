/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Catálogo inglés. Este índice se escribe UNA vez en el commit
 * base de i18n y no se vuelve a tocar: cada unidad de trabajo llena SOLO su
 * propio JSON, de modo que veinte PRs paralelos nunca colisionan aquí.
 *
 * Los `errorsApi*.json` (codes de error de la API, por área del backend) se
 * funden bajo el namespace `errors` para que `apiErrorMessage()` los resuelva
 * con un único `useTranslations('errors')`.
 */

import adminApi from './adminApi.json';
import adminEngagement from './adminEngagement.json';
import adminFundae from './adminFundae.json';
import adminMarca from './adminMarca.json';
import adminMonetizacion from './adminMonetizacion.json';
import adminPagos from './adminPagos.json';
import adminSso from './adminSso.json';
import adminUsuarios from './adminUsuarios.json';
import alumnoAprendizaje from './alumnoAprendizaje.json';
import alumnoSocial from './alumnoSocial.json';
import auth from './auth.json';
import bienvenida from './bienvenida.json';
import common from './common.json';
import comunidadComponentes from './comunidadComponentes.json';
import cuentaComponentes from './cuentaComponentes.json';
import errors from './errors.json';
import errorsApiAdmin from './errorsApiAdmin.json';
import errorsApiAuthSso from './errorsApiAuthSso.json';
import errorsApiModulesA from './errorsApiModulesA.json';
import errorsApiModulesB from './errorsApiModulesB.json';
import errorsApiResto from './errorsApiResto.json';
import formadorAula from './formadorAula.json';
import formadorCursos from './formadorCursos.json';
import libShared from './libShared.json';
import modAiContent from './modAiContent.json';
import modAiGrader from './modAiGrader.json';
import modAiTutor from './modAiTutor.json';
import modAssessments from './modAssessments.json';
import modBilling from './modBilling.json';
import modCertificates from './modCertificates.json';
import modCommunity from './modCommunity.json';
import modFundae from './modFundae.json';
import modGamification from './modGamification.json';
import modMessaging from './modMessaging.json';
import modMigratorLearndash from './modMigratorLearndash.json';
import modNotifications from './modNotifications.json';
import modPaymentConnections from './modPaymentConnections.json';
import modResources from './modResources.json';
import modSubscriptions from './modSubscriptions.json';
import modSurveys from './modSurveys.json';
import modZoomLive from './modZoomLive.json';
import nav from './nav.json';
import playersContenido from './playersContenido.json';
import publicSite from './publicSite.json';
import shell from './shell.json';

export default {
  adminApi,
  adminEngagement,
  adminFundae,
  adminMarca,
  adminMonetizacion,
  adminPagos,
  adminSso,
  adminUsuarios,
  alumnoAprendizaje,
  alumnoSocial,
  auth,
  bienvenida,
  common,
  comunidadComponentes,
  cuentaComponentes,
  errors: {
    ...errors,
    ...errorsApiModulesA,
    ...errorsApiModulesB,
    ...errorsApiAdmin,
    ...errorsApiAuthSso,
    ...errorsApiResto,
  },
  formadorAula,
  formadorCursos,
  libShared,
  modAiContent,
  modAiGrader,
  modAiTutor,
  modAssessments,
  modBilling,
  modCertificates,
  modCommunity,
  modFundae,
  modGamification,
  modMessaging,
  modMigratorLearndash,
  modNotifications,
  modPaymentConnections,
  modResources,
  modSubscriptions,
  modSurveys,
  modZoomLive,
  nav,
  playersContenido,
  publicSite,
  shell,
} as const;
