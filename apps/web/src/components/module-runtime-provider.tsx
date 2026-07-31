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

import { useEffect, useState, type ReactNode } from 'react';
import { initModuleRuntime } from '@/lib/module-runtime';

export interface ModuleRuntimeProviderProps {
  children: ReactNode;
}

export function ModuleRuntimeProvider({ children }: ModuleRuntimeProviderProps) {
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    // Inicializar el runtime solo en el cliente
    try {
      initModuleRuntime();
      setInitialized(true);
    } catch (err) {
      console.error('[ModuleRuntimeProvider] Error inicializando runtime:', err);
      // Aún así renderizar children para no bloquear la app
      setInitialized(true);
    }
  }, []);

  // En SSR, renderizar children sin esperar (el runtime se inicializa en hydration)
  // En el cliente, esperar a que el runtime esté listo
  if (typeof window === 'undefined') {
    return <>{children}</>;
  }

  // Mostrar children inmediatamente - el runtime se inicializa en paralelo
  // Los módulos que intenten cargarse antes recibirán un error claro
  return <>{children}</>;
}
