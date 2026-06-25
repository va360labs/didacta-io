import type { ReactNode } from 'react';

/**
 * Layout del route group `(public)`. Para pantallas accesibles SIN sesión y
 * FUERA del gate de `(app)` (auth/onboarding obligatorio) y de `(auth)`
 * (signin/reset). Centrado, con la misma decoración de fondo tintada al brand
 * que el resto de pantallas públicas. No redeclara html/body: eso vive en el
 * root layout, igual que el `TenantThemeProvider` que aplica el branding del
 * tenant. El wrapper es algo más ancho (max-w-lg) porque alberga el wizard de
 * inscripción de miembros.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg p-4">
      {/* Decoración de fondo: círculos sutiles tintados al brand. */}
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

      <div className="relative z-10 w-full max-w-lg py-8">{children}</div>
    </main>
  );
}
