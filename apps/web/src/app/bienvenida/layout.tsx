/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ReactNode } from 'react';

/**
 * Armazón del asistente de puesta en marcha de la academia.
 *
 * Mismo criterio que `/onboarding` (el de perfil): fuera del shell `(app)`, sin
 * barra lateral ni cabecera. Quien acaba de comprar no debería ver sesenta
 * secciones de administración antes de haberle puesto nombre a su academia —
 * enseñárselas es justo lo que abruma a alguien no técnico.
 *
 * Un pelín más ancho que el de perfil porque aquí hay vistas previas (logo,
 * color) que necesitan sitio para verse.
 */
export default function BienvenidaLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg p-4">
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
      <div className="relative z-10 w-full max-w-3xl py-8">{children}</div>
    </main>
  );
}
