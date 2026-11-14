/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Entry point del surface `admin` del módulo migrator-learndash.
///
/// Este archivo es el TARGET del bundle UI que se distribuye en
/// `dist/ui/admin.js` dentro del ZIP firmado del módulo. El host lo
/// carga en runtime vía `loadModuleUI('mod.migrator-learndash', 'admin')`
/// (apps/web/src/lib/module-loader.ts) y renderiza `<Component>` donde sea.
///
/// El componente default recibe `ModuleUIProps`:
///   - moduleName: string (= 'mod.migrator-learndash')
///   - surface: string (= 'admin')
///   - config: Record<string, unknown> (config persistida del módulo)
///
/// La estructura del surface es 2 pestañas:
///   1. **Crear migración** — wizard multi-paso (welcome → connect → preflight → options → dryrun → execute → done)
///   2. **Monitor de migraciones** — lista de jobs con auto-refresh + cancel + detalle (validation_reports + DLQ)
///
/// alpha.60: primera versión del surface — antes la UI vivía en apps/web/
/// (anti-patrón corregido por ADR-015).

import { React, useState, useLocale, Tabs, TabsContent, TabsList, TabsTrigger } from './_runtime';
import { setActiveLocale, t } from './i18n';
import { MigratorWizard } from './wizard';
import { JobsMonitor } from './jobs-monitor';

interface AdminSurfaceProps {
  moduleName: string;
  surface: string;
  config: Record<string, unknown>;
}

function AdminSurface(_props: AdminSurfaceProps): React.ReactElement {
  // Idioma del host (es/en/pt) ANTES de pintar nada: todos los hijos leen sus
  // textos con `t()`. Al ser un hook, si el idioma cambia se vuelve a pintar
  // la superficie entera con el nuevo.
  setActiveLocale(useLocale());
  const [tab, setTab] = useState<'wizard' | 'monitor'>('wizard');
  return (
    <Tabs
      value={tab}
      onValueChange={(v: string) => setTab(v as 'wizard' | 'monitor')}
      className="space-y-6"
    >
      <TabsList>
        <TabsTrigger value="wizard">{t('admin.tabs.wizard')}</TabsTrigger>
        <TabsTrigger value="monitor">{t('admin.tabs.monitor')}</TabsTrigger>
      </TabsList>
      <TabsContent value="wizard">
        <MigratorWizard />
      </TabsContent>
      <TabsContent value="monitor">
        <JobsMonitor />
      </TabsContent>
    </Tabs>
  );
}

// IMPORTANTE: default export es el componente React. El bundle se construye
// con `esbuild --format=iife --global-name=__didacta_module_exports__`, lo
// cual asigna `window.__didacta_module_exports__ = { default: AdminSurface }`
// — exactamente lo que espera `module-loader.ts` del host al evaluar el bundle.
export default AdminSurface;
