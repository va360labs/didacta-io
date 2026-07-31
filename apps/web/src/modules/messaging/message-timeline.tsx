'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { AuthorNameLink, CommunityAvatar } from '@/components/community-avatar';
import type { MessageView } from './client';
import { dayLabel, timeLabel } from './shared';

/**
 * Timeline de burbujas de una conversación, compartido por `/mensajes` y por el
 * hilo del chat flotante.
 */
export function MessageTimeline({
  messages,
  viewerId,
  showAvatar,
  showAuthor,
  avatars,
}: {
  messages: MessageView[];
  viewerId: string;
  /** Cara del autor junto a la burbuja ajena. */
  showAvatar: boolean;
  /** Nombre del autor dentro de la burbuja: sobra en un directo. */
  showAuthor: boolean;
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
            showAvatar={showAvatar}
            showAuthor={showAuthor}
            avatarUrl={avatars.get(item.msg.authorId)?.avatarUrl ?? null}
          />
        ),
      )}
    </ul>
  );
}

export function MessageBubble({
  msg,
  own,
  showAvatar,
  showAuthor,
  avatarUrl,
}: {
  msg: MessageView;
  own: boolean;
  showAvatar: boolean;
  showAuthor: boolean;
  avatarUrl: string | null;
}) {
  return (
    <li
      className={`flex items-end gap-2 ${own ? 'justify-end' : 'justify-start'}`}
      data-testid="message-bubble"
    >
      {!own && showAvatar ? (
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
        {!own && showAuthor && msg.authorDisplayName ? (
          <AuthorNameLink
            userId={msg.authorId}
            name={msg.authorDisplayName}
            className="text-[11px] font-bold text-brand-700"
          />
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
