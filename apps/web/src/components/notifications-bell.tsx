'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { notificationsApi } from '@/lib/notifications';

const POLL_MS = 60_000;

/**
 * Bell con badge de no leídas. Polling cada 60s mientras la pestaña está
 * visible. Refresca automáticamente al volver a la pestaña (visibilitychange).
 *
 * Implementación deliberadamente simple: sin websockets, sin SSE. Suficiente
 * para v0.1; un usuario que recibe una notificación la verá en máximo ~60s o
 * al cambiar de tab.
 */
export function NotificationsBell() {
  const [count, setCount] = useState(0);
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      const all = await notificationsApi.listMine();
      setCount(all.filter((n) => !n.readAt).length);
    } catch {
      // Silencioso: si el alumno no tiene sesión válida o el endpoint cae,
      // no contaminamos la UI con un error en el header.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refresh();
      }
    }, POLL_MS);
    function onVisibility() {
      if (document.visibilityState === 'visible') void refresh();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  // Si el alumno está en /notificaciones, refrescar el count cuando cambia
  // de página (por si marcó alguna como leída).
  useEffect(() => {
    if (pathname === '/notificaciones') {
      const t = setTimeout(() => void refresh(), 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [pathname, refresh]);

  return (
    <Link
      href="/notificaciones"
      className="relative inline-flex items-center justify-center rounded-md p-2 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      aria-label={count > 0 ? `${count} notificaciones sin leer` : 'Notificaciones'}
      title={count > 0 ? `${count} sin leer` : 'Notificaciones'}
    >
      <BellIcon />
      {count > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
          {count > 99 ? '99+' : count}
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
