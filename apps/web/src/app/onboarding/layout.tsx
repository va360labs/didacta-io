import type { ReactNode } from 'react';

/**
 * Layout del onboarding de primera vez. Fuera del shell `(app)` a propósito:
 * el asistente es bloqueante y se muestra sin sidebar ni header (el usuario no
 * debe ver navegación a la que aún no puede acceder). Centrado, con la misma
 * decoración de fondo que las pantallas de auth. El `TenantThemeProvider` ya
 * vive en el root layout, así que el branding del tenant aplica aquí también.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
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
      <div className="relative z-10 w-full max-w-2xl py-8">{children}</div>
    </main>
  );
}
