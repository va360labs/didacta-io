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

import type { ModuleWebExtension } from '@/lib/module-registry';
import { aiContentExtension } from './ai-content';
import { aiGraderExtension } from './ai-grader';
import { aiTutorExtension } from './ai-tutor';
import { assessmentsExtension } from './assessments';
import { billingExtension } from './billing';
import { certificatesExtension } from './certificates';
import { communityExtension } from './community';
import { fundaeExtension } from './fundae';
import { gamificationExtension } from './gamification';
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
