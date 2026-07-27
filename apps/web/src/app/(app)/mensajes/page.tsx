'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type UIEvent,
} from 'react';
import { CommunityAvatar } from '@/components/community-avatar';
import { Icon } from '@/components/icon';
import { useMessagingContext } from '@/components/messaging-provider';
import { SpaceIcon } from '@/components/space-icon';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { usePublicUsers } from '@/lib/public-users';
import { relTime } from '@/components/community-thread-card';
import {
  messagingApi,
  type ConversationView,
  type MessageView,
  type MessagingPublicUser,
} from '@/modules/messaging';

/**
 * Mensajería de la comunidad (US-M1..M3): salas por espacio, canal de
 * profesores y directos, con tiempo real vía el MessagingProvider del shell.
 * Todos los datos salen de la API de mod.messaging — cero datos inventados.
 */

const STAFF_ROLES = ['formador', 'tenant_admin', 'super_admin'];

/** Clave estable de una conversación en la lista (las salas sin materializar no tienen id). */
function keyOf(c: ConversationView): string {
  return c.id ?? `space:${c.space?.slug ?? c.title}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Hoy';
  if (sameDay(d, yesterday)) return 'Ayer';
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function humanizeError(e: unknown): string {
  if (!(e instanceof ApiHttpError))
    return 'No pudimos cargar los mensajes. Recarga para reintentar.';
  switch (e.code) {
    case 'MESSAGING_NOT_PARTICIPANT':
      return 'No participas en esta conversación.';
    case 'MESSAGING_CONVERSATION_NOT_FOUND':
      return 'La conversación ya no está disponible.';
    case 'MESSAGING_BODY_INVALID':
      return 'El mensaje debe tener entre 1 y 4000 caracteres.';
    case 'MESSAGING_SELF_DM':
      return 'No puedes abrir un directo contigo mismo.';
    default:
      return e.status === 403
        ? 'El módulo de mensajería no está activo en esta comunidad.'
        : e.message;
  }
}

export default function MensajesPage() {
  const session = useMemo(() => authStorage.getSession(), []);
  const viewerId = session?.user.id ?? '';
  const isStaff = useMemo(
    () => (session?.user.roles ?? []).some((r) => STAFF_ROLES.includes(r)),
    [session],
  );
  const { subscribe, refreshUnread } = useMessagingContext();

  const [conversations, setConversations] = useState<ConversationView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [active, setActive] = useState<ConversationView | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  const [newDmOpen, setNewDmOpen] = useState(false);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const reloadConversations = useCallback(async () => {
    try {
      const r = await messagingApi.listConversations();
      setConversations(r.conversations);
      setListError(null);
    } catch (e) {
      setListError(humanizeError(e));
    }
  }, []);

  useEffect(() => {
    void reloadConversations();
  }, [reloadConversations]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  /** Abre una conversación ya materializada (id conocido). */
  const openConversation = useCallback(
    async (conv: ConversationView, id: string) => {
      setActive(conv);
      setActiveId(id);
      // El ref se actualiza YA (no esperamos al re-render): los guards de
      // staleness de abajo comparan contra él.
      activeIdRef.current = id;
      setMessages(null);
      setChatError(null);
      setNextCursor(null);
      setMobileChatOpen(true);
      stickToBottomRef.current = true;
      try {
        const page = await messagingApi.listMessages(id);
        // Respuesta obsoleta: el usuario ya cambió a otra conversación — no
        // pises su timeline ni marques como leído lo que nunca vio.
        if (activeIdRef.current !== id) return;
        // La API devuelve del más reciente al más antiguo; pintamos ascendente.
        setMessages([...page.messages].reverse());
        setNextCursor(page.nextCursor);
        void messagingApi.markRead(id).then(() => refreshUnread());
        setConversations((prev) =>
          prev ? prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)) : prev,
        );
      } catch (e) {
        if (activeIdRef.current === id) setChatError(humanizeError(e));
      }
    },
    [refreshUnread],
  );

  /**
   * Re-sincroniza la conversación abierta (catch-up tras reconexión SSE o tick
   * de polling degradado): trae la última página y fusiona por id sin perder
   * el histórico ya paginado.
   */
  const refreshActiveConversation = useCallback(async () => {
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

  /** Click en un item de la lista (materializa salas si hace falta). */
  const selectConversation = useCallback(
    async (conv: ConversationView) => {
      try {
        if (conv.id) {
          await openConversation(conv, conv.id);
          return;
        }
        if (conv.type === 'SPACE' && conv.space) {
          const { conversationId } = await messagingApi.openSpace(conv.space.slug);
          await openConversation(conv, conversationId);
          void reloadConversations();
        }
      } catch (e) {
        setChatError(humanizeError(e));
      }
    },
    [openConversation, reloadConversations],
  );

  // Eventos realtime del provider: append en la conversación abierta y
  // actualización LOCAL de la lista (sin refetch por evento — el provider ya
  // refresca el badge con debounce). `null` = catch-up (reconexión SSE o tick
  // de polling degradado) → re-sincroniza lista Y conversación abierta.
  useEffect(() => {
    return subscribe((event) => {
      if (event === null) {
        void reloadConversations();
        void refreshActiveConversation();
        return;
      }
      if (event.kind !== 'message.created') return;
      const currentId = activeIdRef.current;
      const tabVisible = typeof document === 'undefined' || !document.hidden;
      const isActive = Boolean(currentId && event.conversationId === currentId);
      if (isActive) {
        setMessages((prev) => {
          if (!prev) return prev;
          if (prev.some((m) => m.id === event.message.id)) return prev;
          return [...prev, event.message];
        });
        // Solo cuenta como leído si el usuario puede estar viéndolo: con la
        // pestaña oculta el mensaje queda pendiente (visibilitychange lo
        // sellará al volver).
        if (tabVisible) {
          void messagingApi.markRead(currentId as string).then(() => refreshUnread());
        }
      }
      setConversations((prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((c) => c.id === event.conversationId);
        if (idx < 0) {
          // Conversación nueva que aún no está en la lista (p. ej. primer DM
          // entrante): un solo refetch la trae.
          void reloadConversations();
          return prev;
        }
        const updated = prev.map((c) =>
          c.id === event.conversationId
            ? {
                ...c,
                lastMessage: {
                  body: event.message.body,
                  kind: event.message.kind,
                  authorDisplayName: event.message.authorDisplayName,
                  createdAt: event.message.createdAt,
                },
                lastMessageAt: event.message.createdAt,
                unreadCount:
                  isActive && tabVisible
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
    });
  }, [subscribe, reloadConversations, refreshActiveConversation, refreshUnread, viewerId]);

  // Al volver a la pestaña con una conversación abierta: sella la lectura de
  // lo que llegó en segundo plano y re-sincroniza (el stream pudo suspenderse).
  useEffect(() => {
    function onVisibility() {
      const id = activeIdRef.current;
      if (document.hidden || !id) return;
      void messagingApi.markRead(id).then(() => refreshUnread());
      setConversations((prev) =>
        prev ? prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)) : prev,
      );
      void refreshActiveConversation();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refreshUnread, refreshActiveConversation]);

  const loadOlder = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const el = scrollRef.current;
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
      if (activeIdRef.current === id) setChatError(humanizeError(e));
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
    setChatError(null);
    try {
      const { message } = await messagingApi.sendMessage(id, body);
      setDraft('');
      stickToBottomRef.current = true;
      setMessages((prev) => {
        if (!prev) return [message];
        if (prev.some((m) => m.id === message.id)) return prev;
        return [...prev, message];
      });
      void reloadConversations();
    } catch (e) {
      setChatError(humanizeError(e));
    } finally {
      setSending(false);
    }
  }, [draft, sending, reloadConversations]);

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // Avatares reales de los autores del hilo abierto (batch + cache en memoria).
  const bubbleAvatars = usePublicUsers((messages ?? []).map((m) => m.authorId));

  const filtered = useMemo(() => {
    if (!conversations) return null;
    const q = filter.trim().toLowerCase();
    return q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations;
  }, [conversations, filter]);

  const groups = useMemo(() => {
    const list = filtered ?? [];
    return {
      salas: list.filter((c) => c.type === 'SPACE'),
      profesores: list.filter((c) => c.type === 'FACULTY'),
      directos: list.filter((c) => c.type === 'DM'),
    };
  }, [filtered]);

  const activeKey = active ? keyOf(active) : null;

  return (
    <div
      className="flex h-[calc(100dvh-11.5rem)] overflow-hidden rounded-xl border border-border bg-surface lg:h-[calc(100vh-9rem)]"
      data-testid="mensajes-page"
    >
      {/* Lista de conversaciones */}
      <div
        className={`${mobileChatOpen ? 'hidden' : 'flex'} w-full shrink-0 flex-col border-r border-border lg:flex lg:w-80`}
      >
        <div className="border-b border-border p-4">
          <div className="flex items-center justify-between">
            <h1 className="font-display text-lg font-bold text-text">Mensajes</h1>
            <button
              type="button"
              onClick={() => setNewDmOpen(true)}
              className="rounded-lg border border-border p-1.5 text-text-muted hover:border-border-strong hover:text-text"
              aria-label="Nueva conversación"
              data-testid="new-dm-button"
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
            <Icon name="search" size={14} className="shrink-0 text-text-muted" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Buscar conversaciones…"
              className="flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
              data-testid="conversations-filter"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto" data-testid="conversations-list">
          {listError ? (
            <div
              role="alert"
              className="m-4 rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {listError}
            </div>
          ) : filtered === null ? (
            <div className="space-y-2 p-4">
              <div className="skeleton h-14 w-full" />
              <div className="skeleton h-14 w-full" />
              <div className="skeleton h-14 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-6 text-center text-sm text-text-muted">
              No hay conversaciones que coincidan.
            </p>
          ) : (
            <>
              <ConversationGroup
                label="Salas"
                items={groups.salas}
                activeKey={activeKey}
                onSelect={selectConversation}
              />
              <ConversationGroup
                label={isStaff ? 'Consultas de alumnos' : 'Profesores'}
                items={groups.profesores}
                activeKey={activeKey}
                onSelect={selectConversation}
              />
              <ConversationGroup
                label="Directos"
                items={groups.directos}
                activeKey={activeKey}
                onSelect={selectConversation}
              />
            </>
          )}
        </div>
      </div>

      {/* Área de chat */}
      <div className={`${mobileChatOpen ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col lg:flex`}>
        {active && activeId ? (
          <>
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setMobileChatOpen(false)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-text-muted hover:text-text lg:hidden"
                aria-label="Volver a la lista"
              >
                <Icon name="arrow-left" size={16} />
              </button>
              <ConversationBadge conv={active} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-text" data-testid="chat-title">
                  {active.title}
                </p>
                {active.type === 'SPACE' && active.space ? (
                  <a
                    href={`/espacios/${encodeURIComponent(active.space.slug)}`}
                    className="text-xs text-text-muted hover:text-text"
                  >
                    Ver espacio en la comunidad
                  </a>
                ) : active.type === 'FACULTY' && !isStaff ? (
                  <p className="text-xs text-text-muted">
                    Tu canal privado con el equipo de profesores
                  </p>
                ) : null}
              </div>
            </div>

            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="flex-1 overflow-y-auto px-4 py-3"
              data-testid="chat-messages"
            >
              {nextCursor ? (
                <div className="pb-2 text-center">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void loadOlder()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Cargando…' : 'Cargar mensajes anteriores'}
                  </Button>
                </div>
              ) : null}
              {messages === null ? (
                <div className="space-y-3">
                  <div className="skeleton h-10 w-2/3" />
                  <div className="skeleton ml-auto h-10 w-1/2" />
                  <div className="skeleton h-10 w-3/5" />
                </div>
              ) : messages.length === 0 ? (
                <p className="py-10 text-center text-sm text-text-muted">
                  {active.type === 'FACULTY' && !isStaff
                    ? 'Escribe tu primera consulta: el equipo de profesores la verá al momento.'
                    : 'Todavía no hay mensajes. Escribe el primero.'}
                </p>
              ) : (
                <MessageTimeline
                  messages={messages}
                  viewerId={viewerId}
                  grouped={active.type !== 'DM'}
                  avatars={bubbleAvatars}
                />
              )}
            </div>

            {chatError ? (
              <div
                role="alert"
                className="mx-4 mb-2 rounded-lg border border-danger-100 bg-danger-50 p-2.5 text-sm text-danger-700"
              >
                {chatError}
              </div>
            ) : null}

            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void send();
              }}
              className="flex items-end gap-2 border-t border-border p-3"
            >
              {/* Sin disabled durante el envío: deshabilitar el textarea roba
                  el foco tras cada Enter y rompe el tecleo encadenado. El
                  guard de envíos concurrentes vive en send(). */}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
                rows={2}
                maxLength={4000}
                placeholder="Escribe un mensaje…"
                className="max-h-40 flex-1 resize-none rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus-visible:border-brand-500 focus-visible:outline-none"
                data-testid="chat-composer-input"
              />
              <Button
                type="submit"
                disabled={sending || draft.trim().length === 0}
                data-testid="chat-send"
              >
                {sending ? 'Enviando…' : 'Enviar'}
              </Button>
            </form>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-base font-semibold text-text">Mensajes</p>
            <p className="text-sm text-text-muted">
              Selecciona una sala, tu canal de profesores o un directo — o inicia una conversación
              nueva.
            </p>
            {chatError ? (
              <div
                role="alert"
                className="mt-2 rounded-lg border border-danger-100 bg-danger-50 p-2.5 text-sm text-danger-700"
              >
                {chatError}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <NewDmDialog
        open={newDmOpen}
        onClose={() => setNewDmOpen(false)}
        onOpened={async (conversationId, member) => {
          setNewDmOpen(false);
          await reloadConversations();
          await openConversation(
            {
              id: conversationId,
              type: 'DM',
              title: member.name ?? 'Miembro',
              space: null,
              counterpart: member,
              lastMessage: null,
              lastMessageAt: null,
              unreadCount: 0,
            },
            conversationId,
          );
        }}
      />
    </div>
  );
}

function ConversationGroup({
  label,
  items,
  activeKey,
  onSelect,
}: {
  label: string;
  items: ConversationView[];
  activeKey: string | null;
  onSelect: (c: ConversationView) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="py-2">
      <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
        {label}
      </p>
      <ul>
        {items.map((c) => {
          const k = keyOf(c);
          const selected = activeKey === k;
          return (
            <li key={k}>
              <button
                type="button"
                onClick={() => onSelect(c)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  selected ? 'bg-bg-subtle' : 'hover:bg-bg-subtle'
                }`}
                data-testid={`conversation-item-${c.type.toLowerCase()}`}
              >
                <ConversationBadge conv={c} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-text">{c.title}</span>
                    {c.lastMessage ? (
                      <span className="shrink-0 text-[11px] text-text-subtle">
                        {relTime(c.lastMessage.createdAt)}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-text-muted">
                      {c.lastMessage
                        ? `${c.lastMessage.authorDisplayName ? `${c.lastMessage.authorDisplayName}: ` : ''}${c.lastMessage.body || '(mensaje eliminado)'}`
                        : 'Sin mensajes todavía'}
                    </span>
                    {c.unreadCount > 0 ? (
                      <span
                        className="grid min-h-4 min-w-4 shrink-0 place-items-center rounded-full bg-brand-500 px-1 text-[10px] font-bold leading-none text-text-on-brand"
                        data-testid="conversation-unread"
                      >
                        {c.unreadCount > 99 ? '99+' : c.unreadCount}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConversationBadge({ conv, size }: { conv: ConversationView; size: number }) {
  if (conv.type === 'SPACE' && conv.space) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-lg bg-bg-subtle"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <SpaceIcon icon={conv.space.icon} color={conv.space.color} size={Math.round(size * 0.55)} />
      </span>
    );
  }
  if (conv.counterpart) {
    return (
      <CommunityAvatar
        userId={conv.counterpart.id}
        name={conv.counterpart.name}
        avatarUrl={conv.counterpart.avatarUrl}
        size={size}
        // El badge vive dentro de <button> de la lista: un link anidado
        // navegaría al perfil en vez de abrir la conversación.
        linkToProfile={false}
      />
    );
  }
  // Canal "Profesores" del alumno: icono de birrete/usuarios.
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg bg-bg-subtle text-text-muted"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Icon name="users" size={Math.round(size * 0.5)} />
    </span>
  );
}

function MessageTimeline({
  messages,
  viewerId,
  grouped,
  avatars,
}: {
  messages: MessageView[];
  viewerId: string;
  grouped: boolean;
  avatars: Map<string, { avatarUrl: string | null }>;
}) {
  const items: Array<{ type: 'day'; label: string } | { type: 'msg'; msg: MessageView }> = [];
  let lastDay = '';
  for (const m of messages) {
    const day = dayLabel(m.createdAt);
    if (day !== lastDay) {
      items.push({ type: 'day', label: day });
      lastDay = day;
    }
    items.push({ type: 'msg', msg: m });
  }

  return (
    <ul className="space-y-2">
      {items.map((item, i) =>
        item.type === 'day' ? (
          <li key={`day-${i}`} className="py-2 text-center">
            <span className="rounded-full bg-bg-subtle px-3 py-1 text-[11px] font-semibold text-text-subtle">
              {item.label}
            </span>
          </li>
        ) : (
          <MessageBubble
            key={item.msg.id}
            msg={item.msg}
            own={item.msg.authorId === viewerId}
            grouped={grouped}
            avatarUrl={avatars.get(item.msg.authorId)?.avatarUrl ?? null}
          />
        ),
      )}
    </ul>
  );
}

function MessageBubble({
  msg,
  own,
  grouped,
  avatarUrl,
}: {
  msg: MessageView;
  own: boolean;
  grouped: boolean;
  avatarUrl: string | null;
}) {
  return (
    <li
      className={`flex items-end gap-2 ${own ? 'justify-end' : 'justify-start'}`}
      data-testid="message-bubble"
    >
      {!own && grouped ? (
        <CommunityAvatar
          userId={msg.authorId}
          name={msg.authorDisplayName}
          avatarUrl={avatarUrl}
          size={26}
        />
      ) : null}
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2 ${
          own
            ? 'rounded-br-md bg-brand-500 text-text-on-brand'
            : 'rounded-bl-md border border-border-soft bg-surface-2 text-text'
        }`}
      >
        {!own && grouped && msg.authorDisplayName ? (
          <p className="text-[11px] font-bold text-brand-700">{msg.authorDisplayName}</p>
        ) : null}
        {msg.deletedAt ? (
          <p className="text-sm italic opacity-70">Mensaje eliminado</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{msg.body}</p>
        )}
        <p
          className={`mt-0.5 text-right text-[10px] ${own ? 'text-text-on-brand/70' : 'text-text-subtle'}`}
        >
          {timeLabel(msg.createdAt)}
        </p>
      </div>
    </li>
  );
}

function NewDmDialog({
  open,
  onClose,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  onOpened: (conversationId: string, member: MessagingPublicUser) => void | Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessagingPublicUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults(null);
      setError(null);
      setOpeningId(null);
      return;
    }
    const handle = setTimeout(() => {
      messagingApi
        .searchMembers(query.trim())
        .then((r) => {
          setResults(r.members);
          setError(null);
        })
        .catch((e) => setError(humanizeError(e)));
    }, 250);
    return () => clearTimeout(handle);
  }, [open, query]);

  async function pick(member: MessagingPublicUser) {
    setOpeningId(member.id);
    setError(null);
    try {
      const { conversationId } = await messagingApi.openDm(member.id);
      await onOpened(conversationId, member);
    } catch (e) {
      setError(humanizeError(e));
      setOpeningId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => (!v ? onClose() : undefined)}
      ariaLabel="Nueva conversación"
    >
      <div className="space-y-3 p-5" data-testid="new-dm-dialog">
        <h2 className="font-display text-lg font-bold text-text">Nueva conversación</h2>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Busca un miembro por nombre…"
          data-testid="new-dm-search"
        />
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-2.5 text-sm text-danger-700"
          >
            {error}
          </div>
        ) : null}
        <div className="max-h-72 overflow-y-auto" data-testid="new-dm-results">
          {results === null ? (
            <div className="space-y-2">
              <div className="skeleton h-11 w-full" />
              <div className="skeleton h-11 w-full" />
            </div>
          ) : results.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-muted">
              Ningún miembro coincide con la búsqueda.
            </p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {results.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => void pick(m)}
                    disabled={openingId !== null}
                    className="flex w-full items-center gap-3 px-1 py-2.5 text-left hover:bg-bg-subtle disabled:opacity-60"
                    data-testid="new-dm-member"
                  >
                    <CommunityAvatar
                      userId={m.id}
                      name={m.name}
                      avatarUrl={m.avatarUrl}
                      size={32}
                      linkToProfile={false}
                    />
                    <span className="flex-1 truncate text-sm font-semibold text-text">
                      {m.name ?? 'Miembro'}
                    </span>
                    {openingId === m.id ? (
                      <span className="text-xs text-text-muted">Abriendo…</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
