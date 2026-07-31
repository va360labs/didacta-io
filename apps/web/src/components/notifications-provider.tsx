'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { notificationsApi } from '@/lib/notifications';
import { useNotificationsStream } from '@/lib/use-notifications-stream';

/**
 * Una notificación en vivo a mostrar como toast. Es un subconjunto del evento
 * SSE: lo justo para renderizar el toast y armar su deep-link.
 */
export interface ToastItem {
  id: string;
  templateKey: string;
  subject: string | null;
  metadata?: Record<string, unknown>;
}

interface NotificationsContextValue {
  /** Nº de notificaciones IN_APP sin leer (para el badge de la campana). */
  unreadCount: number;
  /** Re-hace el catch-up del contador (tras marcar leídas, etc.). */
  refresh: () => void;
  /** Toasts activos, en orden de llegada. */
  toasts: ToastItem[];
  /** Descarta un toast por id. */
  dismissToast: (id: string) => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

/** Máximo de toasts apilados a la vez (los más viejos se descartan). */
const MAX_TOASTS = 4;

/**
 * Dueño ÚNICO del stream SSE de notificaciones en el shell autenticado. Centraliza
 * el transporte (una sola conexión EventSource) y expone por contexto el contador
 * de no leídas (para la campana) y la cola de toasts en vivo (para el toaster).
 *
 * Antes la campana abría su propio stream; al mover el transporte acá evitamos
 * duplicar conexiones cuando además queremos toasts.
 */
export function NotificationsProvider({
  children,
  enabled = true,
}: {
  children: React.ReactNode;
  enabled?: boolean;
}) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const refresh = useCallback(async () => {
    try {
      const all = await notificationsApi.listMine();
      setUnreadCount(all.filter((n) => !n.readAt).length);
    } catch {
      // Silencioso: sin sesión válida o endpoint caído no contaminamos la UI.
    }
  }, []);

  // Catch-up inicial: sembramos el contador antes del primer evento del stream.
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  // Stream SSE: cada evento refresca el contador y, si trae payload (no es un
  // tick de fallback), encola un toast en vivo.
  useNotificationsStream(
    (event) => {
      void refresh();
      if (!event) return;
      setToasts((prev) => {
        if (prev.some((t) => t.id === event.id)) return prev;
        const next: ToastItem[] = [
          ...prev,
          {
            id: event.id,
            templateKey: event.templateKey,
            subject: event.subject,
            metadata: event.metadata,
          },
        ];
        return next.slice(-MAX_TOASTS);
      });
    },
    { enabled },
  );

  // Re-catch-up al volver a la pestaña (el stream pudo perder eventos mientras
  // el navegador lo tuvo suspendido en background).
  useEffect(() => {
    if (!enabled) return undefined;
    function onVisibility() {
      if (document.visibilityState === 'visible') void refresh();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled, refresh]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <NotificationsContext.Provider value={{ unreadCount, refresh, toasts, dismissToast }}>
      {children}
    </NotificationsContext.Provider>
  );
}

/**
 * Acceso al contexto de notificaciones. Devuelve un fallback inerte si se usa
 * fuera del provider, para que un componente aislado (o un test) no rompa.
 */
export function useNotificationsContext(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (ctx) return ctx;
  return {
    unreadCount: 0,
    refresh: () => {},
    toasts: [],
    dismissToast: () => {},
  };
}
