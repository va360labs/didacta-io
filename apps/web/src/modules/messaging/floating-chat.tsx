'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useTranslations } from 'next-intl';
import { CommunityAvatar } from '@/components/community-avatar';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { authStorage } from '@/lib/auth-storage';
import { usePublicUsers } from '@/lib/public-users';
import {
  isChatSoundEnabled,
  playChatChime,
  primeChatSound,
  setChatSoundEnabled,
} from './chat-alert';
import { CHAT_TOAST_MAX, CHAT_TOAST_MS, FLOATING_CHAT_OPEN_KEY } from './constants';
import type { ConversationView } from './client';
import { ConversationBadge } from './conversation-badge';
import { ConversationGroup } from './conversation-list';
import { MessageComposer } from './message-composer';
import { MessageTimeline } from './message-timeline';
import { useMessagingContext } from './messaging-provider';
import { derivePillState, type PillState } from './pill-state';
import { groupConversations, keyOf, STAFF_ROLES } from './shared';
import { useConversationThread } from './use-conversation-thread';

/**
 * Chat flotante de la comunidad (PRD `chat-flotante`).
 *
 * Píldora fija abajo a la derecha con las caras de quien acaba de escribir y la
 * sala donde está pasando; al desplegarse, la MISMA lista agrupada de
 * `/mensajes` y el hilo completo, para responder sin abandonar la página.
 *
 * Sustituye al icono de mensajes del header: un solo indicador de no-leídos en
 * pantalla (regla #5). Todo lo que pinta sale de la API — si no hay dato, lo
 * dice; no se inventa nada (regla #3).
 */
export function FloatingChat() {
  const t = useTranslations('modMessaging');
  const session = useMemo(() => authStorage.getSession(), []);
  const isStaff = useMemo(
    () => (session?.user.roles ?? []).some((r) => STAFF_ROLES.includes(r)),
    [session],
  );
  const { conversations, listError, presence, typing, viewerId, setPresenceTracking, subscribe } =
    useMessagingContext();
  const thread = useConversationThread();

  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<ChatToastItem[]>([]);
  const [soundOn, setSoundOn] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const cornerRef = useRef<HTMLDivElement | null>(null);

  // Estado abierto persistido. Se hidrata en efecto (no en el estado inicial)
  // para no descuadrar el HTML del servidor.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(FLOATING_CHAT_OPEN_KEY) === '1') setOpen(true);
    } catch {
      /* almacenamiento bloqueado: el panel simplemente arranca cerrado */
    }
  }, []);

  const setOpenPersisted = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(FLOATING_CHAT_OPEN_KEY, next ? '1' : '0');
    } catch {
      /* idem */
    }
  }, []);

  // La presencia solo se consulta con el panel abierto (ADR-019).
  useEffect(() => {
    setPresenceTracking(open);
    return () => setPresenceTracking(false);
  }, [open, setPresenceTracking]);

  // Esc cierra (primero el hilo, luego el panel) y devuelve el foco a la píldora.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (thread.activeId) {
        thread.close();
        return;
      }
      setOpenPersisted(false);
      pillRef.current?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, thread, setOpenPersisted]);

  // Foco contenido dentro del panel mientras está abierto.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const root = panelRef.current;
      if (!root) return;
      const focusables = [
        ...root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // El panel a pantalla completa (móvil) no debe dejar scrollar el fondo.
  useEffect(() => {
    if (!open) return;
    const mobile = window.matchMedia('(max-width: 1023px)');
    if (!mobile.matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // ── Aviso con el chat plegado ────────────────────────────────────────────
  // Con la píldora cerrada, un mensaje nuevo solo cambiaba una línea de texto
  // en una esquina: fácil de no ver. Ahora avisa con un toast, la burbuja roja
  // de la píldora y un tono corto que se puede silenciar.

  useEffect(() => {
    setSoundOn(isChatSoundEnabled());
    return primeChatSound();
  }, []);

  const conversationsRef = useRef<ConversationView[] | null>(null);
  conversationsRef.current = conversations;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    return subscribe((event) => {
      if (event === null || event.kind !== 'message.created') return;
      // Con el panel abierto el mensaje ya se ve; los propios nunca avisan.
      if (openRef.current || event.message.authorId === viewerId) return;

      const conversation =
        conversationsRef.current?.find((c) => c.id === event.conversationId) ?? null;
      setToasts((prev) =>
        [
          ...prev.filter((t) => t.conversationId !== event.conversationId),
          {
            id: event.message.id,
            conversationId: event.conversationId,
            author: event.message.authorDisplayName,
            authorId: event.message.authorId,
            // Sin conversación en la lista todavía (primer DM entrante), el
            // toast se queda sin titulo antes que inventarse uno.
            title: conversation?.title ?? null,
            isRoom: conversation?.type === 'SPACE',
            body: event.message.body,
          },
        ].slice(-CHAT_TOAST_MAX),
      );
      playChatChime();
    });
  }, [subscribe, viewerId]);

  // Al abrir el panel, los avisos pendientes sobran: ya está mirando.
  useEffect(() => {
    if (open) setToasts([]);
  }, [open]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /**
   * Borde superior de la esquina del chat (píldora + avisos), en px desde el
   * fondo del viewport. El toaster de notificaciones lo lee para apilarse
   * encima sin numeros magicos que se rompan al cambiar la altura de nada.
   */
  useEffect(() => {
    const el = cornerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const fromBottom = Math.round(window.innerHeight - rect.top);
    document.documentElement.style.setProperty('--didacta-chat-corner', `${fromBottom}px`);
    return () => {
      document.documentElement.style.removeProperty('--didacta-chat-corner');
    };
  }, [toasts.length, open]);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      setChatSoundEnabled(next);
      // Suena al activarlo: así se oye exactamente lo que se está aceptando.
      if (next) playChatChime();
      return next;
    });
  }, []);

  const openConversationFromToast = useCallback(
    (conversationId: string) => {
      const conversation = conversationsRef.current?.find((c) => c.id === conversationId) ?? null;
      setOpenPersisted(true);
      setToasts([]);
      if (conversation) void thread.select(conversation);
    },
    [setOpenPersisted, thread],
  );

  const pill = useMemo<PillState>(
    () => derivePillState({ conversations, typing, viewerId, now: Date.now() }, t),
    [conversations, typing, viewerId, t],
  );
  const pillAvatars = usePublicUsers(pill.avatarUserIds);

  if (!session) return null;

  return (
    <div
      ref={cornerRef}
      className="fixed right-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-(--z-chat) flex flex-col items-end lg:right-5 lg:bottom-5"
      data-testid="floating-chat"
    >
      {open ? (
        <ChatPanel
          ref={panelRef}
          isStaff={isStaff}
          soundOn={soundOn}
          onToggleSound={toggleSound}
          onClose={() => {
            setOpenPersisted(false);
            pillRef.current?.focus();
          }}
          thread={thread}
          conversations={conversations}
          listError={listError}
          presence={presence}
        />
      ) : null}

      {!open && toasts.length > 0 ? (
        <div
          className="mb-2.5 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2"
          role="status"
          aria-live="polite"
        >
          {toasts.map((toast) => (
            <ChatToast
              key={toast.id}
              toast={toast}
              onOpen={() => openConversationFromToast(toast.conversationId)}
              onDismiss={() => dismissToast(toast.id)}
            />
          ))}
        </div>
      ) : null}

      <ChatPill
        ref={pillRef}
        pill={pill}
        avatars={pillAvatars}
        open={open}
        onToggle={() => setOpenPersisted(!open)}
      />
    </div>
  );
}

// ── Píldora ─────────────────────────────────────────────────────────────────

function ChatPill({
  ref,
  pill,
  avatars,
  open,
  onToggle,
}: {
  ref: Ref<HTMLButtonElement>;
  pill: PillState;
  avatars: Map<string, { name: string | null; avatarUrl: string | null }>;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('modMessaging');
  const label = pill.line1.target ? `${pill.line1.prefix} ${pill.line1.target}` : pill.line1.prefix;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? t('closeMessages') : t('pillOpenLabel', { label })}
      data-testid="chat-pill"
      className="flex h-12 items-center gap-3 rounded-full bg-[var(--didacta-night)] py-0 pl-2 pr-3 text-left shadow-[0_8px_22px_rgba(13,27,42,0.28)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0 lg:h-[46px] lg:pr-4"
    >
      <span className="flex shrink-0 items-center">
        {pill.avatarUserIds.length > 0 ? (
          pill.avatarUserIds.map((userId, i) => (
            <span
              key={userId}
              // La cara entra con un fundido corto al llegar un mensaje nuevo:
              // el `key` por usuario hace que React remonte solo la que cambia.
              className="animate-in fade-in rounded-full ring-2 ring-[var(--didacta-night)] motion-reduce:animate-none"
              style={{ marginLeft: i === 0 ? 0 : -10, zIndex: 10 - i }}
              data-testid="chat-pill-avatar"
            >
              <CommunityAvatar
                userId={userId}
                name={avatars.get(userId)?.name ?? null}
                avatarUrl={avatars.get(userId)?.avatarUrl ?? null}
                size={30}
                linkToProfile={false}
              />
            </span>
          ))
        ) : (
          <span className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-white">
            <Icon name="messages" size={16} />
          </span>
        )}
        {/* Burbuja roja de no-leídos, pegada a las caras. En movil la pildora
            colapsa a los avatares y es lo unico que queda; en escritorio
            acompaña al texto, que por si solo pasaba desapercibido. */}
        {pill.unreadConversations > 0 ? (
          <span
            className="ml-1 grid min-h-[1.15rem] min-w-[1.15rem] place-items-center rounded-full bg-danger-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-[var(--didacta-night)]"
            data-testid="chat-pill-unread"
          >
            {pill.unreadConversations > 99 ? '99+' : pill.unreadConversations}
          </span>
        ) : null}
      </span>

      {/* Con una sola línea el bloque se centra; con dos, interlineado corto
          para que no queden flotando separadas dentro de la píldora. */}
      <span className="hidden min-w-0 flex-col justify-center lg:flex" aria-live="polite">
        <span className="truncate text-[13px] font-semibold leading-tight text-white">
          {pill.line1.prefix}
          {pill.line1.target ? (
            <>
              {' '}
              <span style={{ color: 'var(--didacta-growth-on-dark)' }}>{pill.line1.target}</span>
            </>
          ) : null}
        </span>
        {pill.line2 ? (
          <span className="truncate text-[11.5px] leading-tight text-white/65">{pill.line2}</span>
        ) : null}
      </span>
    </button>
  );
}

// ── Aviso de mensaje nuevo (chat plegado) ───────────────────────────────────

interface ChatToastItem {
  /** Id del mensaje: sirve de clave y evita repetir el mismo aviso. */
  id: string;
  conversationId: string;
  author: string | null;
  authorId: string;
  /** Título de la conversación; `null` si aún no está en la lista. */
  title: string | null;
  isRoom: boolean;
  body: string;
}

function ChatToast({
  toast,
  onOpen,
  onDismiss,
}: {
  toast: ChatToastItem;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('modMessaging');

  useEffect(() => {
    const handle = setTimeout(onDismiss, CHAT_TOAST_MS);
    return () => clearTimeout(handle);
  }, [onDismiss]);

  const who = toast.author?.trim() || t('someone');
  // Sala → «Fulano en #general»; directo o conversación aún sin título → solo
  // el nombre. Frase completa por key: nada de concatenar « en » a mano.
  const heading =
    toast.title && toast.isRoom
      ? t('toastAuthorInRoom', { who, room: toast.title })
      : t('toastAuthor', { who });

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 flex items-start gap-2.5 rounded-xl border border-border-soft bg-surface p-3 shadow-lg ring-1 ring-black/5 duration-200 motion-reduce:animate-none"
      data-testid="chat-toast"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        data-testid="chat-toast-open"
      >
        <CommunityAvatar userId={toast.authorId} name={toast.author} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-text">{heading}</span>
          <span className="mt-0.5 line-clamp-2 block text-xs text-text-muted">
            {toast.body || t('previewDeleted')}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('toastDismiss')}
        className="shrink-0 rounded-md p-1 text-text-subtle transition-colors hover:bg-bg-subtle hover:text-text"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

type ThreadApi = ReturnType<typeof useConversationThread>;

function ChatPanel({
  ref,
  isStaff,
  soundOn,
  onToggleSound,
  onClose,
  thread,
  conversations,
  listError,
  presence,
}: {
  ref: Ref<HTMLDivElement>;
  isStaff: boolean;
  soundOn: boolean;
  onToggleSound: () => void;
  onClose: () => void;
  thread: ThreadApi;
  conversations: ReturnType<typeof useMessagingContext>['conversations'];
  listError: string | null;
  presence: ReturnType<typeof useMessagingContext>['presence'];
}) {
  const t = useTranslations('modMessaging');
  const groups = useMemo(() => groupConversations(conversations ?? []), [conversations]);
  const onlineUserIds = useMemo(() => new Set(presence.onlineUserIds), [presence.onlineUserIds]);
  // La presencia se cuenta sin el propio usuario: «3 personas activas» son otras
  // tres, no dos y yo.
  const othersOnline = Math.max(0, presence.onlineCount - 1);
  const activeKey = thread.active ? keyOf(thread.active) : null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={t('panelTitle')}
      data-testid="chat-panel"
      // Alto acotado al viewport: en pantallas bajas el panel no puede salirse
      // por arriba ni empujar a la píldora fuera de la ventana.
      className="animate-in fade-in slide-in-from-bottom-2 fixed inset-0 flex flex-col overflow-hidden bg-surface duration-200 motion-reduce:animate-none lg:absolute lg:inset-auto lg:bottom-[calc(100%+0.75rem)] lg:right-0 lg:h-[min(34rem,calc(100vh-8rem))] lg:w-[25rem] lg:rounded-2xl lg:border lg:border-border lg:shadow-[0_12px_32px_rgba(13,27,42,0.16)]"
    >
      {thread.active && thread.activeId ? (
        <ThreadHeader thread={thread} onClose={onClose} />
      ) : (
        <div className="flex items-center justify-between gap-2 border-b border-border-soft px-4 py-3">
          <div className="min-w-0">
            <p className="font-display text-sm font-bold text-text">{t('panelTitle')}</p>
            {othersOnline > 0 ? (
              <p className="text-xs font-semibold" style={{ color: 'var(--didacta-growth)' }}>
                {t('panelOnline', { count: othersOnline })}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onToggleSound}
              aria-pressed={soundOn}
              aria-label={soundOn ? t('panelSoundMute') : t('panelSoundUnmute')}
              title={soundOn ? t('panelSoundOnTitle') : t('panelSoundOffTitle')}
              data-testid="chat-sound-toggle"
              className="grid h-8 w-8 place-items-center rounded-lg text-text-muted transition-colors hover:bg-bg-subtle hover:text-text"
            >
              <Icon name={soundOn ? 'volume' : 'volume-off'} size={16} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('closeMessages')}
              data-testid="chat-panel-close"
              className="grid h-8 w-8 place-items-center rounded-lg text-text-muted transition-colors hover:bg-bg-subtle hover:text-text"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
      )}

      {thread.active && thread.activeId ? (
        <ThreadBody thread={thread} isStaff={isStaff} />
      ) : (
        <>
          {/* `overscroll-contain`: al llegar al final de la lista, la rueda deja
              de propagarse y NO arrastra el scroll de la página de detrás. */}
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            data-testid="chat-panel-list"
          >
            {listError ? (
              <div
                role="alert"
                className="m-4 rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
              >
                {listError}
              </div>
            ) : conversations === null ? (
              <div className="space-y-2 p-4">
                <div className="skeleton h-12 w-full" />
                <div className="skeleton h-12 w-full" />
                <div className="skeleton h-12 w-full" />
              </div>
            ) : conversations.length === 0 ? (
              <p className="p-6 text-center text-sm text-text-muted">{t('panelEmpty')}</p>
            ) : (
              <>
                <ConversationGroup
                  label={t('groupSalas')}
                  items={groups.salas}
                  activeKey={activeKey}
                  onSelect={(c) => void thread.select(c)}
                  showCount
                  dense
                  size={32}
                />
                <ConversationGroup
                  label={isStaff ? t('groupConsultas') : t('groupProfesores')}
                  items={groups.profesores}
                  activeKey={activeKey}
                  onSelect={(c) => void thread.select(c)}
                  onlineUserIds={onlineUserIds}
                  showCount
                  dense
                  size={32}
                />
                <ConversationGroup
                  label={t('groupDirectos')}
                  items={groups.directos}
                  activeKey={activeKey}
                  onSelect={(c) => void thread.select(c)}
                  onlineUserIds={onlineUserIds}
                  showCount
                  dense
                  size={32}
                />
              </>
            )}
          </div>
          <div className="border-t border-border-soft px-4 py-3">
            <a
              href="/mensajes"
              className="text-[13px] font-semibold text-brand-600 hover:text-brand-700"
              data-testid="chat-panel-see-all"
            >
              {t('seeAll')}
            </a>
          </div>
        </>
      )}
    </div>
  );
}

function ThreadHeader({ thread, onClose }: { thread: ThreadApi; onClose: () => void }) {
  const t = useTranslations('modMessaging');
  if (!thread.active) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2.5">
      <button
        type="button"
        onClick={thread.close}
        aria-label={t('panelBack')}
        data-testid="chat-panel-back"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-bg-subtle hover:text-text"
      >
        <Icon name="arrow-left" size={16} />
      </button>
      <ConversationBadge conv={thread.active} size={28} />
      <p
        className="min-w-0 flex-1 truncate text-sm font-bold text-text"
        data-testid="chat-panel-title"
      >
        {thread.active.title}
      </p>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('closeMessages')}
        data-testid="chat-panel-close"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-bg-subtle hover:text-text"
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

function ThreadBody({ thread, isStaff }: { thread: ThreadApi; isStaff: boolean }) {
  const t = useTranslations('modMessaging');
  if (!thread.active) return null;
  return (
    <>
      <div
        ref={thread.scrollRef}
        onScroll={thread.onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
        data-testid="chat-panel-messages"
      >
        {thread.nextCursor ? (
          <div className="pb-2 text-center">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void thread.loadOlder()}
              disabled={thread.loadingMore}
            >
              {thread.loadingMore ? t('loadingOlder') : t('loadOlder')}
            </Button>
          </div>
        ) : null}
        {thread.messages === null ? (
          <div className="space-y-3">
            <div className="skeleton h-9 w-2/3" />
            <div className="skeleton ml-auto h-9 w-1/2" />
          </div>
        ) : thread.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            {thread.active.type === 'FACULTY' && !isStaff
              ? t('threadEmptyFaculty')
              : t('threadEmpty')}
          </p>
        ) : (
          <MessageTimeline
            messages={thread.messages}
            viewerId={thread.viewerId}
            // En el panel la cara va SIEMPRE, también en directos: con 400 px de
            // ancho y sin cabecera de página, es lo que sitúa de un vistazo quién
            // habla. El nombre dentro de la burbuja sigue sobrando en un directo.
            showAvatar
            showAuthor={thread.active.type !== 'DM'}
            avatars={thread.avatars}
          />
        )}
      </div>

      {thread.error ? (
        <div
          role="alert"
          className="mx-3 mb-2 rounded-lg border border-danger-100 bg-danger-50 p-2 text-xs text-danger-700"
        >
          {thread.error}
        </div>
      ) : null}

      <MessageComposer
        value={thread.draft}
        onChange={thread.setDraft}
        onSend={() => void thread.send()}
        sending={thread.sending}
        onTyping={thread.notifyTyping}
        compact
      />
    </>
  );
}
