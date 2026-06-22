/// Entry point del surface `admin` del módulo zoom-live.
///
/// Target del bundle UI distribuido en `dist/ui/admin.js` dentro del ZIP
/// firmado. El host lo carga en runtime vía
/// `loadModuleUI('mod.zoom-live', 'admin')` y lo renderiza en el tab
/// "Aula virtual" de /admin/configuracion.
///
/// ADR-015: la UI real vive aquí (en el módulo), no en apps/web/.

import { React } from './_runtime';
import { ZoomCredentialsCard } from './credentials-card';

interface AdminSurfaceProps {
  moduleName: string;
  surface: string;
  config: Record<string, unknown>;
}

function AdminSurface(_props: AdminSurfaceProps): React.ReactElement {
  return <ZoomCredentialsCard />;
}

// El bundle se construye con `esbuild --format=iife --global-name=__didacta_module_exports__`,
// lo cual asigna `window.__didacta_module_exports__ = { default: AdminSurface }`.
export default AdminSurface;
