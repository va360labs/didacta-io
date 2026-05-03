/**
 * Module Loader — Carga dinámica de bundles UI de módulos instalados.
 *
 * Este loader permite cargar componentes React de módulos instalados vía
 * marketplace sin necesidad de Module Federation. Los bundles se compilan
 * con esbuild en formato IIFE y se sirven desde object storage.
 *
 * FLUJO:
 *   1. `loadModuleUI(moduleName, surface)` hace fetch del bundle.
 *   2. El bundle se evalúa en un contexto donde `__didacta__` existe.
 *   3. El bundle asigna sus exports a `window.__didacta_module_exports__`.
 *   4. El loader captura el componente default y lo retorna.
 *   5. El componente se puede renderizar con React.Suspense.
 *
 * SEGURIDAD:
 *   - Los bundles ya pasaron validación de lint en el backend (ModuleLintService).
 *   - El código se ejecuta en el mismo contexto que el host (no es sandbox).
 *   - Para aislamiento adicional, considerar Web Workers o iframes.
 *
 * @see DISC-001.2 — Module UI Loader
 * @see module-runtime.ts — Runtime que expone dependencias
 */

import type { ComponentType } from 'react';
import { initModuleRuntime } from './module-runtime';

export interface ModuleUIMetadata {
  moduleName: string;
  surface: 'admin' | 'formador' | 'alumno' | 'auditor' | 'empresa_manager';
  version: string;
  bundleUrl: string;
}

export interface LoadedModuleUI {
  /** Componente React default exportado por el módulo. */
  Component: ComponentType<ModuleUIProps>;
  /** Metadata del módulo. */
  metadata: ModuleUIMetadata;
  /** Exports adicionales del módulo (named exports). */
  exports: Record<string, unknown>;
}

export interface ModuleUIProps {
  /** Nombre del módulo (para contexto). */
  moduleName: string;
  /** Configuración actual del módulo (valores guardados en BD). */
  config: Record<string, unknown>;
  /** Surface donde se está renderizando. */
  surface: string;
}

/** Cache de módulos ya cargados para evitar re-fetch. */
const loadedModules = new Map<string, LoadedModuleUI>();

/** Promesas in-flight para evitar cargas duplicadas concurrentes. */
const loadingPromises = new Map<string, Promise<LoadedModuleUI>>();

/**
 * Genera la clave de cache para un módulo + surface.
 */
function cacheKey(moduleName: string, surface: string): string {
  return `${moduleName}:${surface}`;
}

/**
 * Obtiene la URL del bundle UI de un módulo.
 *
 * El backend sirve los assets del módulo en:
 *   GET /api/v1/modules/:name/ui/:surface.js
 *
 * Este endpoint lee el blob del object storage y lo retorna con el
 * Content-Type correcto. El cache se maneja vía ETag/If-None-Match.
 */
function getBundleUrl(moduleName: string, surface: string): string {
  // El nombre del módulo viene como "mod.migrator-learndash", extraemos el slug
  const slug = moduleName.replace(/^mod\./, '');
  return `/api/v1/modules/${slug}/ui/${surface}.js`;
}

/**
 * Carga el bundle UI de un módulo instalado.
 *
 * @param moduleName - Nombre del módulo (ej: "mod.migrator-learndash")
 * @param surface - Surface a cargar (ej: "admin")
 * @returns Promesa con el componente y metadata
 * @throws Error si el módulo no tiene UI para esa surface o falla la carga
 *
 * @example
 * ```tsx
 * const { Component, metadata } = await loadModuleUI('mod.migrator-learndash', 'admin');
 * return <Component moduleName={metadata.moduleName} config={config} surface="admin" />;
 * ```
 */
export async function loadModuleUI(
  moduleName: string,
  surface: ModuleUIMetadata['surface'],
): Promise<LoadedModuleUI> {
  const key = cacheKey(moduleName, surface);

  // Cache hit
  if (loadedModules.has(key)) {
    return loadedModules.get(key)!;
  }

  // Evitar cargas duplicadas concurrentes
  if (loadingPromises.has(key)) {
    return loadingPromises.get(key)!;
  }

  const loadPromise = (async (): Promise<LoadedModuleUI> => {
    // Asegurar que el runtime está inicializado
    initModuleRuntime();

    const bundleUrl = getBundleUrl(moduleName, surface);

    // Fetch del bundle
    const response = await fetch(bundleUrl);
    if (!response.ok) {
      if (response.status === 404) {
        throw new ModuleUINotFoundError(
          moduleName,
          surface,
          `El módulo "${moduleName}" no tiene UI para surface "${surface}"`,
        );
      }
      throw new ModuleUILoadError(
        moduleName,
        surface,
        `Error cargando UI del módulo: ${response.status} ${response.statusText}`,
      );
    }

    const bundleCode = await response.text();
    const version = response.headers.get('X-Module-Version') ?? 'unknown';

    // Limpiar exports previos
    window.__didacta_module_exports__ = undefined;

    // Evaluar el bundle
    // El bundle está compilado como IIFE que asigna a __didacta_module_exports__
    // Formato esperado:
    //   (function() {
    //     const { React, ui, hooks, api } = __didacta__;
    //     // ... código del módulo ...
    //     window.__didacta_module_exports__ = { default: Component, ... };
    //   })();
    try {
      // eslint-disable-next-line no-new-func
      const evaluator = new Function(bundleCode);
      evaluator();
    } catch (err) {
      throw new ModuleUILoadError(
        moduleName,
        surface,
        `Error ejecutando bundle del módulo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Capturar exports
    const exports = window.__didacta_module_exports__ as Record<string, unknown> | undefined;
    if (!exports || typeof exports !== 'object') {
      throw new ModuleUILoadError(
        moduleName,
        surface,
        'El bundle del módulo no exportó correctamente (falta __didacta_module_exports__)',
      );
    }

    const Component = exports.default as ComponentType<ModuleUIProps> | undefined;
    if (!Component || typeof Component !== 'function') {
      throw new ModuleUILoadError(
        moduleName,
        surface,
        'El bundle del módulo no tiene export default válido',
      );
    }

    const loaded: LoadedModuleUI = {
      Component,
      metadata: {
        moduleName,
        surface,
        version,
        bundleUrl,
      },
      exports: { ...exports },
    };

    // Limpiar y cachear
    window.__didacta_module_exports__ = undefined;
    loadedModules.set(key, loaded);
    loadingPromises.delete(key);

    return loaded;
  })();

  loadingPromises.set(key, loadPromise);
  return loadPromise;
}

/**
 * Invalida el cache de un módulo (útil tras actualización).
 */
export function invalidateModuleUICache(moduleName: string, surface?: string): void {
  if (surface) {
    loadedModules.delete(cacheKey(moduleName, surface));
  } else {
    // Invalidar todas las surfaces del módulo
    for (const key of loadedModules.keys()) {
      if (key.startsWith(`${moduleName}:`)) {
        loadedModules.delete(key);
      }
    }
  }
}

/**
 * Verifica si un módulo tiene UI cargada.
 */
export function isModuleUILoaded(moduleName: string, surface: string): boolean {
  return loadedModules.has(cacheKey(moduleName, surface));
}

// ─────────────────────────────────────────────────────────────────────────────
// Errores tipados
// ─────────────────────────────────────────────────────────────────────────────

export class ModuleUILoadError extends Error {
  constructor(
    public readonly moduleName: string,
    public readonly surface: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModuleUILoadError';
  }
}

export class ModuleUINotFoundError extends ModuleUILoadError {
  constructor(moduleName: string, surface: string, message: string) {
    super(moduleName, surface, message);
    this.name = 'ModuleUINotFoundError';
  }
}
