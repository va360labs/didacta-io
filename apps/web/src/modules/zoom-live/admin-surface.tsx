'use client';

/// Wrapper genérico que carga el surface 'admin' del bundle UI del módulo
/// mod.zoom-live en lugar de importar el componente directamente.
///
/// Cumple ADR-015: el host solo contiene infra genérica de carga (loadModuleUI).
/// La UI real vive en modules/zoom-live/src/ui/ y se distribuye en el ZIP
/// firmado del módulo — un update del UI no requiere rebuild del Docker image.

import { useEffect, useState } from 'react';
import { loadModuleUI } from '@/lib/module-loader';
import type { ComponentType } from 'react';
import type { ModuleUIProps } from '@/lib/module-loader';

export function ZoomAdminSurface() {
  const [Component, setComponent] = useState<ComponentType<ModuleUIProps> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadModuleUI('mod.zoom-live', 'admin')
      .then(({ Component: C }) => setComponent(() => C))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Error cargando configuración de Zoom.'),
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
    return <div className="skeleton h-32 w-full" />;
  }
  return <Component moduleName="mod.zoom-live" config={{}} surface="admin" />;
}
