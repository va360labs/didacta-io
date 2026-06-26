'use client';

import type { ReactNode } from 'react';
import { useTenantContext } from '@/lib/tenant-context';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { tenant } = useTenantContext();

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
          {tenant?.logoUrl ? (
            // Marca del tenant (mod.theming). El src puede ser absoluto o
            // relativo al API same-origin; <img> lo resuelve sin next/image.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={tenant.logoUrl}
              alt={tenant.name}
              className="mx-auto max-h-16 w-auto object-contain"
            />
          ) : (
            <>
              <p className="label-uppercase text-text-muted">VA360 LABS</p>
              <h1 className="font-display mt-2 text-3xl font-extrabold tracking-tight text-brand-700">
                {tenant?.name ?? 'Didacta'}
              </h1>
              <p className="mt-1 text-sm text-text-subtle">
                Plataforma educativa abierta y modular.
              </p>
            </>
          )}
        </header>
        {children}
      </div>
    </main>
  );
}
