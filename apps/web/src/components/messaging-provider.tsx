'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { authStorage } from '@/lib/auth-storage';
import { messagingApi, type MessagingStreamEvent } from '@/modules/messaging/client';
import { useMessagingStream } from '@/modules/messaging/use-messaging-stream';

/**
 * Dueño ÚNICO del stream SSE de mensajería en el shell autenticado (mismo
 * patrón que NotificationsProvider): mantiene el contador de conversaciones
 * con no-leídos para el badge del header y reparte los eventos crudos a los
 * consumidores (la página /mensajes) vía subscribe.
 */

type Subscriber = (event: MessagingStreamEvent | null) => void;

interface MessagingContextValue {
  /** Nº de conversaciones con mensajes sin leer (badge del header). */
  unreadConversations: number;
  /** Re-consulta el contador (p. ej. tras marcar como leído). */
  refreshUnread: () => void;
  /** Suscripción a eventos del stream; devuelve la función de baja. */
  subscribe: (cb: Subscriber) => () => void;
}

const MessagingContext = createContext<MessagingContextValue | null>(null);

export function MessagingProvider({ children }: { children: ReactNode }) {
  const [unreadConversations, setUnreadConversations] = useState(0);
  const subscribersRef = useRef<Set<Subscriber>>(new Set());
  const enabled = useMemo(() => Boolean(authStorage.getSession()), []);

  const refreshUnread = useCallback(() => {
    if (!authStorage.getSession()) return;
    messagingApi
      .listConversations()
      .then((r) => {
        setUnreadConversations(r.conversations.filter((c) => c.unreadCount > 0).length);
      })
      .catch(() => {
        /* best-effort: el badge no debe romper el shell */
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refreshUnread();
  }, [enabled, refreshUnread]);

  // Al volver a la pestaña, el stream pudo perder eventos suspendido.
  useEffect(() => {
    if (!enabled) return;
    function onVisibility() {
      if (!document.hidden) refreshUnread();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled, refreshUnread]);

  // Colapsa las recargas del contador: un aluvión de mensajes (sala activa)
  // dispara UNA consulta como mucho cada 1,5s, no una por evento y pestaña.
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefreshUnread = useCallback(() => {
    if (refreshDebounceRef.current !== null) return;
    refreshDebounceRef.current = setTimeout(() => {
      refreshDebounceRef.current = null;
      refreshUnread();
    }, 1_500);
  }, [refreshUnread]);

  useEffect(() => {
    return () => {
      if (refreshDebounceRef.current !== null) clearTimeout(refreshDebounceRef.current);
    };
  }, []);

  useMessagingStream(
    (event) => {
      for (const cb of subscribersRef.current) cb(event);
      scheduleRefreshUnread();
    },
    { enabled },
  );

  const subscribe = useCallback((cb: Subscriber) => {
    subscribersRef.current.add(cb);
    return () => {
      subscribersRef.current.delete(cb);
    };
  }, []);

  const value = useMemo<MessagingContextValue>(
    () => ({ unreadConversations, refreshUnread, subscribe }),
    [unreadConversations, refreshUnread, subscribe],
  );

  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>;
}

/** Fallback inerte fuera del provider (p. ej. tests aislados). */
const INERT: MessagingContextValue = {
  unreadConversations: 0,
  refreshUnread: () => undefined,
  subscribe: () => () => undefined,
};

export function useMessagingContext(): MessagingContextValue {
  return useContext(MessagingContext) ?? INERT;
}
