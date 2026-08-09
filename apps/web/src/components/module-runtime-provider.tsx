'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Module Runtime Provider — Inicializa el runtime de módulos dinámicos.
 *
 * Este provider debe envolver la aplicación (o al menos las partes que
 * pueden renderizar módulos dinámicos). Inicializa el objeto global
 * `__didacta__` que los bundles de módulos usan para acceder a React,
 * componentes UI, hooks y APIs del host.
 *
 * @see DISC-001 — Sistema de Plugins
 * @see module-runtime.ts — Runtime que expone dependencias
 *
 * @example
 * ```tsx
 * // En el layout root
 * export default function RootLayout({ children }) {
 *   return (
 *     <html>
 *       <body>
 *         <ModuleRuntimeProvider>
 *           {children}
 *         </ModuleRuntimeProvider>
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */

import { useEffect, type ReactNode } from 'react';
import { initModuleRuntime } from '@/lib/module-runtime';

export interface ModuleRuntimeProviderProps {
  children: ReactNode;
}

export function ModuleRuntimeProvider({ children }: ModuleRuntimeProviderProps) {
  useEffect(() => {
    // Inicializar el runtime solo en el cliente.
    //
    // NO hay estado `initialized`: los children se pintan igual antes y después
    // (ver abajo), así que guardarlo solo provocaba un render extra. Si algún
    // día hace falta bloquear el árbol hasta que el runtime esté listo, hay que
    // reintroducir el estado Y usarlo en el return — no basta con escribirlo.
    try {
      initModuleRuntime();
    } catch (err) {
      console.error('[ModuleRuntimeProvider] Error inicializando runtime:', err);
      // Aún así renderizamos children para no bloquear la app.
    }
  }, []);

  // Mostrar children inmediatamente — tanto en SSR como en cliente. El runtime
  // se inicializa en paralelo y los módulos que intenten cargarse antes reciben
  // un error claro desde `getModuleRuntime()`.
  return <>{children}</>;
}
