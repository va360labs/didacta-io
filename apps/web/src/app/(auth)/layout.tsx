import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-900">
      <div className="w-full max-w-md">
        <header className="mb-6 text-center">
          <p className="text-xs uppercase tracking-widest text-neutral-500">VA360 LABS</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">LearnShip</h1>
        </header>
        {children}
      </div>
    </main>
  );
}
