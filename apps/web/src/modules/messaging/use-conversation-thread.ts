'use client';

import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react';
import { usePublicUsers } from '@/lib/public-users';
import { messagingApi, type ConversationView, type MessageView } from './client';
import { useMessagingContext } from './messaging-provider';
import { humanizeError } from './shared';

/**
 * Toda la mecánica de una conversación abierta: histórico paginado, envío,
 * marcado de leído, merge del realtime y avisos de escritura.
 *
 * Vive en un hook porque lo usan DOS superficies —la página `/mensajes` y el
 * hilo del chat flotante— y es justo donde más fácil se descuadran los
 * no-leídos si cada una lleva su propia copia (regla #5).
 */
export function useConversationThread() {
  const { subscribe, refreshConversations, markReadLocally, registerActiveConversation, viewerId } =
    useMessagingContext();

  const [active, setActive] = useState<ConversationView | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollElRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /**
   * Ref de callback, no ref de objeto: hace falta enterarse de CUÁNDO se monta
   * el contenedor, no solo tenerlo a mano.
   *
   * Al plegar el chat flotante su panel se desmonta, pero la conversación sigue
   * abierta en este hook. Al reabrirlo, el contenedor es un nodo NUEVO con
   * `scrollTop = 0` — es decir, el mensaje más antiguo — y ningún efecto lo
   * corrige porque `messages` no ha cambiado. Se baja al último al montar, que
   * además es lo que uno espera de un chat al reabrirlo.
   */
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollElRef.current = el;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    // Segunda pasada tras el layout: con avatares o fuentes aún por asentar,
    // el scrollHeight del primer tick se queda corto.
    requestAnimationFrame(() => {
      if (scrollElRef.current === el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  // Mientras la conversación esté abierta, lo que llegue a ella no suma
  // no-leídos en la lista del provider.
  useEffect(() => {
    if (!activeId) return;
    return registerActiveConversation(activeId);
  }, [activeId, registerActiveConversation]);

  const markRead = useCallback(
    (id: string) => {
      void messagingApi.markRead(id).then(() => markReadLocally(id));
    },
    [markReadLocally],
  );

  /** Abre una conversación ya materializada (id conocido). */
  const openConversation = useCallback(
    async (conv: ConversationView, id: string) => {
      setActive(conv);
      setActiveId(id);
      // El ref se actualiza YA (no esperamos al re-render): los guards de
      // staleness de abajo comparan contra él.
      activeIdRef.current = id;
      setMessages(null);
      setError(null);
      setNextCursor(null);
      setDraft('');
      stickToBottomRef.current = true;
      try {
        const page = await messagingApi.listMessages(id);
        // Respuesta obsoleta: el usuario ya cambió a otra conversación — no
        // pises su timeline ni marques como leído lo que nunca vio.
        if (activeIdRef.current !== id) return;
        // La API devuelve del más reciente al más antiguo; pintamos ascendente.
        setMessages([...page.messages].reverse());
        setNextCursor(page.nextCursor);
        markRead(id);
      } catch (e) {
        if (activeIdRef.current === id) setError(humanizeError(e));
      }
    },
    [markRead],
  );

  /** Click en un item de la lista (materializa salas si hace falta). */
  const select = useCallback(
    async (conv: ConversationView) => {
      try {
        if (conv.id) {
          await openConversation(conv, conv.id);
          return;
        }
        if (conv.type === 'SPACE' && conv.space) {
          const { conversationId } = await messagingApi.openSpace(conv.space.slug);
          await openConversation(conv, conversationId);
          void refreshConversations();
        }
      } catch (e) {
        setError(humanizeError(e));
      }
    },
    [openConversation, refreshConversations],
  );

  const close = useCallback(() => {
    setActive(null);
    setActiveId(null);
    activeIdRef.current = null;
    setMessages(null);
    setNextCursor(null);
    setError(null);
    setDraft('');
  }, []);

  /**
   * Re-sincroniza la conversación abierta (catch-up tras reconexión SSE o tick
   * de polling degradado): trae la última página y fusiona por id sin perder el
   * histórico ya paginado.
   */
  const refreshActive = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      const page = await messagingApi.listMessages(id);
      if (activeIdRef.current !== id) return;
      setMessages((prev) => {
        const fetched = [...page.messages].reverse();
        if (!prev) return fetched;
        const known = new Set(prev.map((m) => m.id));
        const fresh = fetched.filter((m) => !known.has(m.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    } catch {
      /* catch-up best-effort: el siguiente tick lo reintenta */
    }
  }, []);

  // Eventos realtime: append en la conversación abierta. La lista la mantiene
  // el provider — aquí solo vive el timeline.
  useEffect(() => {
    return subscribe((event) => {
      if (event === null) {
        void refreshActive();
        return;
      }
      if (event.kind !== 'message.created') return;
      const currentId = activeIdRef.current;
      if (!currentId || event.conversationId !== currentId) return;
      setMessages((prev) => {
        if (!prev) return prev;
        if (prev.some((m) => m.id === event.message.id)) return prev;
        return [...prev, event.message];
      });
      // Solo cuenta como leído si el usuario puede estar viéndolo: con la
      // pestaña oculta el mensaje queda pendiente (visibilitychange lo sellará).
      const tabVisible = typeof document === 'undefined' || !document.hidden;
      if (tabVisible) markRead(currentId);
    });
  }, [subscribe, refreshActive, markRead]);

  // Al volver a la pestaña con una conversación abierta: sella la lectura de lo
  // que llegó en segundo plano y re-sincroniza (el stream pudo suspenderse).
  useEffect(() => {
    function onVisibility() {
      const id = activeIdRef.current;
      if (document.hidden || !id) return;
      markRead(id);
      void refreshActive();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [markRead, refreshActive]);

  const loadOlder = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const el = scrollElRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      const page = await messagingApi.listMessages(id, nextCursor);
      // Respuesta obsoleta (el usuario cambió de conversación en vuelo): no
      // prependa mensajes de otra conversación en la nueva.
      if (activeIdRef.current !== id) return;
      stickToBottomRef.current = false;
      setMessages((prev) => [...[...page.messages].reverse(), ...(prev ?? [])]);
      setNextCursor(page.nextCursor);
      // Mantiene la posición visual tras prepender.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch (e) {
      if (activeIdRef.current === id) setError(humanizeError(e));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (el.scrollTop < 60 && nextCursor && !loadingMore) void loadOlder();
    },
    [nextCursor, loadingMore, loadOlder],
  );

  const send = useCallback(async () => {
    const id = activeIdRef.current;
    const body = draft.trim();
    if (!id || !body || sending) return;
    setSending(true);
    setError(null);
    try {
      const { message } = await messagingApi.sendMessage(id, body);
      setDraft('');
      stickToBottomRef.current = true;
      setMessages((prev) => {
        if (!prev) return [message];
        if (prev.some((m) => m.id === message.id)) return prev;
        return [...prev, message];
      });
      void refreshConversations();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setSending(false);
    }
  }, [draft, sending, refreshConversations]);

  /** Aviso de escritura: best-effort puro, ya acelerado por el composer. */
  const notifyTyping = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    void messagingApi.notifyTyping(id).catch(() => {
      /* si falla, el otro simplemente no ve el indicador */
    });
  }, []);

  // Avatares reales de los autores del hilo abierto (batch + cache en memoria).
  const avatars = usePublicUsers((messages ?? []).map((m) => m.authorId));

  return {
    active,
    activeId,
    messages,
    avatars,
    nextCursor,
    loadingMore,
    error,
    setError,
    draft,
    setDraft,
    sending,
    viewerId,
    scrollRef,
    select,
    openConversation,
    close,
    send,
    loadOlder,
    onScroll,
    notifyTyping,
  };
}
