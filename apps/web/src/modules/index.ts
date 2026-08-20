/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Catálogo de extensiones de UI agregadas por los módulos del repo.
///
/// Cada módulo vive bajo `apps/web/src/modules/<name>/` y exporta un
/// `ModuleWebExtension` desde su `index.ts`. Aquí lo importamos y lo
/// metemos en el array que el core consume.
///
/// Convención (ADR pendiente de redactar): NUNCA añadir UI de un módulo
/// fuera de su carpeta. Si el día de mañana `mod.zoom-live` se publica
/// como `*.zip` distribuible, esta carpeta entera se empaqueta
/// y el catálogo runtime (loader del marketplace) reemplaza este import
/// estático.

import type { ModulePublicRoute, ModuleWebExtension } from '@/lib/module-registry';
import { assertNoPublicRouteCollisions } from '@/lib/public-route-match';
import { aiContentExtension } from './ai-content';
import { aiGraderExtension } from './ai-grader';
import { aiTutorExtension } from './ai-tutor';
import { assessmentsExtension } from './assessments';
import { billingExtension } from './billing';
import { certificatesExtension } from './certificates';
import { communityExtension } from './community';
import { fundaeExtension } from './fundae';
import { gamificationExtension } from './gamification';
import { helloWorldExtension } from './hello-world';
import { migratorLearndashExtension } from './migrator-learndash';
import { notificationsExtension } from './notifications';
import { paymentConnectionsExtension } from './payment-connections';
import { resourcesExtension } from './resources';
import { subscriptionsExtension } from './subscriptions';
import { surveysExtension } from './surveys';
import { zoomLiveExtension } from './zoom-live';

export const moduleExtensions: readonly ModuleWebExtension[] = [
  aiContentExtension,
  aiGraderExtension,
  aiTutorExtension,
  assessmentsExtension,
  billingExtension,
  certificatesExtension,
  communityExtension,
  fundaeExtension,
  gamificationExtension,
  helloWorldExtension,
  migratorLearndashExtension,
  notificationsExtension,
  paymentConnectionsExtension,
  resourcesExtension,
  subscriptionsExtension,
  surveysExtension,
  zoomLiveExtension,
];

/// Devuelve todos los `adminConfigTabs` declarados por el conjunto de
/// extensions, en el orden en que vienen del catálogo. El caller filtra
/// por módulos activos del tenant antes de renderizar.
export function flatAdminConfigTabs(
  extensions: readonly ModuleWebExtension[] = moduleExtensions,
): Array<{
  moduleName: string;
  tab: NonNullable<ModuleWebExtension['adminConfigTabs']>[number];
}> {
  return extensions.flatMap((ext) =>
    (ext.adminConfigTabs ?? []).map((tab) => ({ moduleName: ext.name, tab })),
  );
}

/// Devuelve todas las rutas públicas declaradas por el conjunto de
/// extensions, con el módulo que las trae. El caller filtra por módulos
/// activos del tenant antes de renderizar nada.
export function flatPublicRoutes(
  extensions: readonly ModuleWebExtension[] = moduleExtensions,
): Array<{ moduleName: string; route: ModulePublicRoute }> {
  return extensions.flatMap((ext) =>
    (ext.publicRoutes ?? []).map((route) => ({ moduleName: ext.name, route })),
  );
}

/// Dos módulos no pueden reclamar la misma ruta pública.
///
/// La comprobación se hace AQUÍ, al construir el catálogo, y no al servir una
/// petición: este módulo se importa estáticamente en el build, así que una
/// colisión rompe la compilación. Resolverla por orden de import sería elegir
/// ganador en función de cómo estén escritas las líneas de arriba, que es
/// exactamente el tipo de dependencia invisible que luego nadie encuentra.
assertNoPublicRouteCollisions(
  flatPublicRoutes().map(({ moduleName, route }) => ({ moduleName, pattern: route.pattern })),
);
