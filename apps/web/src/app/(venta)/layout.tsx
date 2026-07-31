/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ReactNode } from 'react';

/**
 * Layout del route group `(venta)`: páginas públicas de COMPRA (p. ej. /unete).
 * Es hermano de `(public)` pero ANCHO (aquel es max-w-lg para wizards): la
 * página de membresía es un layout de dos columnas estilo checkout. Sin gate
 * de sesión — el visitante aún no tiene cuenta.
 */
export default function VentaLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-dvh overflow-x-clip bg-bg">
      {/* Decoración de fondo tintada al brand, como el resto de públicas. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{ zIndex: 0 }}
      >
        <div
          className="absolute -left-32 -top-32 h-96 w-96 rounded-full opacity-30 blur-3xl"
          style={{ backgroundColor: 'hsl(var(--brand-h) 80% 88%)' }}
        />
        <div
          className="absolute -bottom-32 -right-32 h-[28rem] w-[28rem] rounded-full opacity-20 blur-3xl"
          style={{ backgroundColor: 'hsl(174 70% 80%)' }}
        />
      </div>
      <div className="relative z-10 mx-auto w-full max-w-[1340px] px-4 py-8 md:py-12">
        {children}
      </div>
    </main>
  );
}
