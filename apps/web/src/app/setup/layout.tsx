/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ReactNode } from 'react';

export default function SetupLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-bg">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{ zIndex: 0 }}
      >
        <div
          className="absolute -left-40 -top-40 h-[28rem] w-[28rem] rounded-full opacity-30 blur-3xl"
          style={{ backgroundColor: 'hsl(var(--brand-h) 80% 88%)' }}
        />
        <div
          className="absolute -bottom-40 -right-40 h-[32rem] w-[32rem] rounded-full opacity-20 blur-3xl"
          style={{ backgroundColor: 'hsl(174 70% 80%)' }}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-dvh max-w-3xl flex-col px-4 py-10 sm:py-16">
        {children}
      </div>
    </main>
  );
}
