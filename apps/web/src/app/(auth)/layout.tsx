import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
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

      <div className="relative z-10 w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="label-uppercase text-text-muted">VA360 LABS</p>
          <h1 className="font-display mt-2 text-3xl font-extrabold tracking-tight text-brand-700">
            Didacta
          </h1>
          <p className="mt-1 text-sm text-text-subtle">Plataforma educativa abierta y modular.</p>
        </header>
        {children}
      </div>
    </main>
  );
}
