'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useState } from 'react';
import { CommunityAvatar } from '@/components/community-avatar';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { authStorage } from '@/lib/auth-storage';
import {
  ConversationBadge,
  ConversationGroup,
  MessageComposer,
  MessageTimeline,
  groupConversations,
  humanizeError,
  keyOf,
  messagingApi,
  useConversationThread,
  useMessagingContext,
  STAFF_ROLES,
  type ConversationView,
  type MessagingPublicUser,
} from '@/modules/messaging';

/**
 * Mensajería de la comunidad (US-M1..M3): salas por espacio, canal de
 * profesores y directos, con tiempo real vía el MessagingProvider del shell.
 *
 * La lista, el timeline y el composer son los MISMOS componentes que usa el
 * chat flotante (`modules/messaging/`): esta página es la vista completa, no
 * una implementación paralela. Todos los datos salen de la API de mod.messaging
 * — cero datos inventados.
 */
export default function MensajesPage() {
  const session = useMemo(() => authStorage.getSession(), []);
  const isStaff = useMemo(
    () => (session?.user.roles ?? []).some((r) => STAFF_ROLES.includes(r)),
    [session],
  );
  const { conversations, listError, presence, refreshConversations } = useMessagingContext();
  const thread = useConversationThread();

  const [filter, setFilter] = useState('');
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);

  const onlineUserIds = useMemo(() => new Set(presence.onlineUserIds), [presence.onlineUserIds]);

  const filtered = useMemo(() => {
    if (!conversations) return null;
    const q = filter.trim().toLowerCase();
    return q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations;
  }, [conversations, filter]);

  const groups = useMemo(() => groupConversations(filtered ?? []), [filtered]);
  const activeKey = thread.active ? keyOf(thread.active) : null;

  async function selectConversation(conv: ConversationView) {
    setMobileChatOpen(true);
    await thread.select(conv);
  }

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
                onlineUserIds={onlineUserIds}
              />
              <ConversationGroup
                label="Directos"
                items={groups.directos}
                activeKey={activeKey}
                onSelect={selectConversation}
                onlineUserIds={onlineUserIds}
              />
            </>
          )}
        </div>
      </div>

      {/* Área de chat */}
      <div className={`${mobileChatOpen ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col lg:flex`}>
        {thread.active && thread.activeId ? (
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
              <ConversationBadge conv={thread.active} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-text" data-testid="chat-title">
                  {thread.active.title}
                </p>
                {thread.active.type === 'SPACE' && thread.active.space ? (
                  <a
                    href={`/espacios/${encodeURIComponent(thread.active.space.slug)}`}
                    className="text-xs text-text-muted hover:text-text"
                  >
                    Ver espacio en la comunidad
                  </a>
                ) : thread.active.type === 'FACULTY' && !isStaff ? (
                  <p className="text-xs text-text-muted">
                    Tu canal privado con el equipo de profesores
                  </p>
                ) : null}
              </div>
            </div>

            <div
              ref={thread.scrollRef}
              onScroll={thread.onScroll}
              className="flex-1 overflow-y-auto px-4 py-3"
              data-testid="chat-messages"
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
                    {thread.loadingMore ? 'Cargando…' : 'Cargar mensajes anteriores'}
                  </Button>
                </div>
              ) : null}
              {thread.messages === null ? (
                <div className="space-y-3">
                  <div className="skeleton h-10 w-2/3" />
                  <div className="skeleton ml-auto h-10 w-1/2" />
                  <div className="skeleton h-10 w-3/5" />
                </div>
              ) : thread.messages.length === 0 ? (
                <p className="py-10 text-center text-sm text-text-muted">
                  {thread.active.type === 'FACULTY' && !isStaff
                    ? 'Escribe tu primera consulta: el equipo de profesores la verá al momento.'
                    : 'Todavía no hay mensajes. Escribe el primero.'}
                </p>
              ) : (
                <MessageTimeline
                  messages={thread.messages}
                  viewerId={thread.viewerId}
                  showAvatar={thread.active.type !== 'DM'}
                  showAuthor={thread.active.type !== 'DM'}
                  avatars={thread.avatars}
                />
              )}
            </div>

            {thread.error ? (
              <div
                role="alert"
                className="mx-4 mb-2 rounded-lg border border-danger-100 bg-danger-50 p-2.5 text-sm text-danger-700"
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
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-base font-semibold text-text">Mensajes</p>
            <p className="text-sm text-text-muted">
              Selecciona una sala, tu canal de profesores o un directo — o inicia una conversación
              nueva.
            </p>
            {thread.error ? (
              <div
                role="alert"
                className="mt-2 rounded-lg border border-danger-100 bg-danger-50 p-2.5 text-sm text-danger-700"
              >
                {thread.error}
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
          setMobileChatOpen(true);
          await refreshConversations();
          await thread.openConversation(
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
