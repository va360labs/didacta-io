'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useNotificationsContext } from './notifications-provider';

/**
 * Bell con badge de no leídas. El contador y el transporte SSE viven en el
 * `NotificationsProvider` (una sola conexión compartida con el toaster); la
 * campana solo lo consume por contexto.
 */
export function NotificationsBell() {
  const { unreadCount, refresh } = useNotificationsContext();
  const pathname = usePathname();

  // Si el alumno está en /notificaciones, refrescar el contador cuando cambia
  // de página (por si marcó alguna como leída).
  useEffect(() => {
    if (pathname === '/notificaciones') {
      const t = setTimeout(() => refresh(), 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [pathname, refresh]);

  return (
    <Link
      href="/notificaciones"
      className="relative inline-flex items-center justify-center rounded-md p-2 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      aria-label={unreadCount > 0 ? `${unreadCount} notificaciones sin leer` : 'Notificaciones'}
      title={unreadCount > 0 ? `${unreadCount} sin leer` : 'Notificaciones'}
    >
      <BellIcon />
      {unreadCount > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      ) : null}
    </Link>
  );
}

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.6}
      stroke="currentColor"
      className="h-5 w-5"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
      />
    </svg>
  );
}
