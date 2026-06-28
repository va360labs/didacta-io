'use client';

/// Ruta /formador/aula-virtual: loader GENÉRICO del surface 'formador' del módulo
/// mod.zoom-live. Cumple ADR-015 / Regla 3: la UI real vive en
/// modules/zoom-live/src/ui/formador.tsx y se distribuye en el bundle del módulo
/// (dist/ui/formador.js); el host solo hace `loadModuleUI`. (Antes esta página
/// inlineaba 439 líneas de UI específica del módulo — violación de Regla 3.)

import { useEffect, useState } from 'react';
import { loadModuleUI } from '@/lib/module-loader';
import type { ComponentType } from 'react';
import type { ModuleUIProps } from '@/lib/module-loader';

export default function AulaVirtualPage() {
  const [Component, setComponent] = useState<ComponentType<ModuleUIProps> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadModuleUI('mod.zoom-live', 'formador')
      .then(({ Component: C }) => setComponent(() => C))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Error cargando el aula virtual.'),
      );
  }, []);

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
      >
        {error}
      </div>
    );
  }
  if (!Component) {
    return <div className="skeleton h-64 w-full" />;
  }
  return <Component moduleName="mod.zoom-live" config={{}} surface="formador" />;
}
