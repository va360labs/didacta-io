'use client';

import { type ReactNode } from 'react';
import { NotificationsBell } from '@/components/notifications-bell';

interface Props {
  title: string;
  description?: string;
  actions?: ReactNode;
}

/**
 * Header del shell de la app. Sigue el spec del UI kit
 * (`docs/ui-kit/ui_kits/learn/Header.jsx`): título Sora 20/700, fondo blanco,
 * border-b sutil, altura 64px, padding-x 32px.
 *
 * El search global está deferido — se añade cuando el backend tenga endpoint
 * `/search?q=` consolidado. Por ahora dejamos el slot vacío.
 */
export function AppHeader({ title, description, actions }: Props) {
  return (
    <header className="flex h-16 items-center gap-4 border-b border-border-soft bg-surface px-8">
      <div className="min-w-0 flex-1">
        <h1
          className="font-display text-xl font-bold leading-none text-text"
          style={{ letterSpacing: '-0.01em' }}
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-1 truncate text-xs text-text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      <NotificationsBell />
    </header>
  );
}
