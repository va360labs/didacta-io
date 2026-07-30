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
import {
  messagingApi,
  type ConversationView,
  type MessagingStreamEvent,
  type PresenceSnapshot,
} from './client';
import { useMessagingStream } from './use-messaging-stream';

/**
 * Dueño ÚNICO del estado de mensajería en el shell autenticado: el stream SSE,
 * la lista de conversaciones, la presencia y las señales de «está escribiendo».
 *
 * Antes este provider pedía la lista completa de conversaciones y se quedaba
 * solo con el número de no-leídos; el resto (salas, últimos mensajes, autores)
 * se tiraba y la página `/mensajes` volvía a pedirlo. Ahora la lista vive aquí y
 * la consumen las dos superficies —la página y el chat flotante— sin duplicar
 * peticiones ni lógica de merge.
 */

type Subscriber = (event: MessagingStreamEvent | null) => void;

/** Señal viva de «alguien está escribiendo» (ADR-019: expira sola). */
export interface TypingSignal {
  conversationId: string;
  userId: string;
  displayName: string | null;
  /** Epoch ms en el que deja de mostrarse. */
  expiresAt: number;
}

const EMPTY_PRESENCE: PresenceSnapshot = { onlineCount: 0, onlineUserIds: [] };

/** Cadencia de sondeo de presencia mientras el panel está abierto. */
const PRESENCE_POLL_MS = 30_000;

interface MessagingContextValue {
  /** Conversaciones del usuario. `null` = aún cargando. */
  conversations: ConversationView[] | null;
  /** Error humanizado del listado, si lo hubo. */
  listError: string | null;
  /** Nº de conversaciones con mensajes sin leer. */
  unreadConversations: number;
  /** Presencia del aula. Solo se refresca con el sondeo activado. */
  presence: PresenceSnapshot;
  /** Señales de escritura vivas (ya podadas por expiración). */
  typing: TypingSignal[];
  /** Id del usuario actual (vacío si no hay sesión). */
  viewerId: string;
  /** Re-consulta la lista completa. */
  refreshConversations: () => Promise<void>;
  /** Pone a 0 el contador local de una conversación (tras marcar leído). */
  markReadLocally: (conversationId: string) => void;
  /**
   * Declara una conversación como abierta en pantalla: mientras lo esté, los
   * mensajes que lleguen a ella no suman no-leídos. Devuelve la baja.
   */
  registerActiveConversation: (conversationId: string) => () => void;
  /** Activa/desactiva el sondeo de presencia (lo enciende el panel al abrirse). */
  setPresenceTracking: (enabled: boolean) => void;
  /** Suscripción a eventos crudos del stream; devuelve la función de baja. */
  subscribe: (cb: Subscriber) => () => void;
}

const MessagingContext = createContext<MessagingContextValue | null>(null);

export function MessagingProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<ConversationView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [presence, setPresence] = useState<PresenceSnapshot>(EMPTY_PRESENCE);
  const [typing, setTyping] = useState<TypingSignal[]>([]);

  const subscribersRef = useRef<Set<Subscriber>>(new Set());
  const activeRef = useRef<Set<string>>(new Set());
  const session = useMemo(() => authStorage.getSession(), []);
  const viewerId = session?.user.id ?? '';
  const enabled = Boolean(session);

  const unreadConversations = useMemo(
    () => (conversations ?? []).filter((c) => c.unreadCount > 0).length,
    [conversations],
  );

  const refreshConversations = useCallback(async () => {
    if (!authStorage.getSession()) return;
    try {
      const r = await messagingApi.listConversations();
      setConversations(r.conversations);
      setListError(null);
    } catch (e) {
      // Best-effort: el shell nunca se rompe porque falle la mensajería. El
      // primer fallo deja la lista como está y anota el error para la UI.
      setListError(
        e instanceof Error && e.message
          ? e.message
          : 'No pudimos cargar los mensajes. Recarga para reintentar.',
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refreshConversations();
  }, [enabled, refreshConversations]);

  // Al volver a la pestaña, el stream pudo perder eventos suspendido.
  useEffect(() => {
    if (!enabled) return;
    function onVisibility() {
      if (!document.hidden) void refreshConversations();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled, refreshConversations]);

  // Colapsa las recargas: un aluvión de mensajes (sala activa) dispara UNA
  // consulta como mucho cada 1,5 s, no una por evento y pestaña.
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshDebounceRef.current !== null) return;
    refreshDebounceRef.current = setTimeout(() => {
      refreshDebounceRef.current = null;
      void refreshConversations();
    }, 1_500);
  }, [refreshConversations]);

  useEffect(() => {
    return () => {
      if (refreshDebounceRef.current !== null) clearTimeout(refreshDebounceRef.current);
    };
  }, []);

  const markReadLocally = useCallback((conversationId: string) => {
    setConversations((prev) =>
      prev ? prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)) : prev,
    );
  }, []);

  const registerActiveConversation = useCallback((conversationId: string) => {
    activeRef.current.add(conversationId);
    return () => {
      activeRef.current.delete(conversationId);
    };
  }, []);

  /** Aplica un mensaje entrante a la lista sin refetch (el badge ya se refresca aparte). */
  const applyIncomingMessage = useCallback(
    (event: Extract<MessagingStreamEvent, { kind: 'message.created' }>) => {
      const tabVisible = typeof document === 'undefined' || !document.hidden;
      const isActive = activeRef.current.has(event.conversationId) && tabVisible;
      setConversations((prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((c) => c.id === event.conversationId);
        if (idx < 0) {
          // Conversación que aún no está en la lista (p. ej. primer DM
          // entrante): un solo refetch la trae.
          scheduleRefresh();
          return prev;
        }
        const updated = prev.map((c) =>
          c.id === event.conversationId
            ? {
                ...c,
                lastMessage: {
                  body: event.message.body,
                  kind: event.message.kind,
                  authorId: event.message.authorId,
                  authorDisplayName: event.message.authorDisplayName,
                  createdAt: event.message.createdAt,
                },
                lastMessageAt: event.message.createdAt,
                unreadCount: isActive
                  ? 0
                  : event.message.authorId === viewerId
                    ? c.unreadCount
                    : c.unreadCount + 1,
              }
            : c,
        );
        updated.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
        return updated;
      });

      // Quien acaba de mandar un mensaje ya no está escribiendo.
      setTyping((prev) =>
        prev.filter(
          (t) =>
            !(t.conversationId === event.conversationId && t.userId === event.message.authorId),
        ),
      );
    },
    [scheduleRefresh, viewerId],
  );

  useMessagingStream(
    (event) => {
      for (const cb of subscribersRef.current) cb(event);
      if (event === null) {
        // Catch-up tras reconexión o tick de polling degradado: los indicadores
        // de escritura del hueco ya no valen nada.
        setTyping([]);
        void refreshConversations();
        return;
      }
      if (event.kind === 'message.created') {
        applyIncomingMessage(event);
        return;
      }
      if (event.kind === 'typing') {
        // El propio autor nunca se ve escribir (el backend ya lo excluye; esto
        // cubre el caso de varias pestañas del mismo usuario).
        if (event.userId === viewerId) return;
        const signal: TypingSignal = {
          conversationId: event.conversationId,
          userId: event.userId,
          displayName: event.displayName,
          expiresAt: Date.now() + event.ttlMs,
        };
        setTyping((prev) => [
          ...prev.filter(
            (t) => !(t.conversationId === signal.conversationId && t.userId === signal.userId),
          ),
          signal,
        ]);
      }
    },
    { enabled },
  );

  // Poda de las señales de escritura. Un setTimeout por señal no basta: con la
  // pestaña suspendida los timers se retrasan, así que se recalcula contra el
  // reloj y solo mientras haya algo que podar.
  useEffect(() => {
    if (typing.length === 0) return;
    const tick = setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        const alive = prev.filter((t) => t.expiresAt > now);
        return alive.length === prev.length ? prev : alive;
      });
    }, 1_000);
    return () => clearInterval(tick);
  }, [typing.length]);

  // Presencia: solo se consulta con el panel abierto (ADR-019 — nada de empujar
  // presencia por SSE a todo el tenant).
  const [presenceTracking, setPresenceTracking] = useState(false);
  useEffect(() => {
    if (!enabled || !presenceTracking) return;
    let cancelled = false;
    const load = () => {
      messagingApi
        .getPresence()
        .then((p) => {
          if (!cancelled) setPresence(p);
        })
        .catch(() => {
          /* best-effort: sin presencia el panel simplemente no la muestra */
        });
    };
    load();
    const id = setInterval(load, PRESENCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, presenceTracking]);

  const subscribe = useCallback((cb: Subscriber) => {
    subscribersRef.current.add(cb);
    return () => {
      subscribersRef.current.delete(cb);
    };
  }, []);

  const value = useMemo<MessagingContextValue>(
    () => ({
      conversations,
      listError,
      unreadConversations,
      presence,
      typing,
      viewerId,
      refreshConversations,
      markReadLocally,
      registerActiveConversation,
      setPresenceTracking,
      subscribe,
    }),
    [
      conversations,
      listError,
      unreadConversations,
      presence,
      typing,
      viewerId,
      refreshConversations,
      markReadLocally,
      registerActiveConversation,
      subscribe,
    ],
  );

  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>;
}

/** Fallback inerte fuera del provider (p. ej. tests aislados). */
const INERT: MessagingContextValue = {
  conversations: null,
  listError: null,
  unreadConversations: 0,
  presence: EMPTY_PRESENCE,
  typing: [],
  viewerId: '',
  refreshConversations: async () => undefined,
  markReadLocally: () => undefined,
  registerActiveConversation: () => () => undefined,
  setPresenceTracking: () => undefined,
  subscribe: () => () => undefined,
};

export function useMessagingContext(): MessagingContextValue {
  return useContext(MessagingContext) ?? INERT;
}
