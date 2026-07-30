'use client';

import { relTime } from '@/components/community-thread-card';
import type { ConversationView } from './client';
import { ConversationBadge } from './conversation-badge';
import { keyOf, previewOf } from './shared';

/**
 * Grupo de conversaciones de la bandeja. Lo usan la página `/mensajes` y el
 * panel del chat flotante — una sola implementación de la fila, para que las dos
 * superficies no diverjan (regla #5).
 */
export function ConversationGroup({
  label,
  items,
  activeKey,
  onSelect,
  onlineUserIds,
  showCount = false,
  size = 36,
  dense = false,
}: {
  label: string;
  items: ConversationView[];
  activeKey: string | null;
  onSelect: (c: ConversationView) => void;
  /** Ids con presencia activa; sin ellos no se pinta ningún punto verde. */
  onlineUserIds?: Set<string>;
  /** Contador a la derecha de la cabecera del grupo (panel flotante). */
  showCount?: boolean;
  size?: number;
  dense?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className={dense ? '' : 'py-2'}>
      <div
        className={`flex items-center justify-between gap-2 ${
          dense ? 'bg-bg-subtle/60 px-4 pb-1.5 pt-2.5' : 'px-4 pb-1'
        }`}
      >
        <p className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-text-subtle">
          {label}
        </p>
        {showCount ? (
          <span className="text-[10.5px] font-semibold text-text-subtle">{items.length}</span>
        ) : null}
      </div>
      <ul>
        {items.map((c) => {
          const k = keyOf(c);
          const selected = activeKey === k;
          const online = Boolean(
            c.counterpart && onlineUserIds && onlineUserIds.has(c.counterpart.id),
          );
          return (
            <li key={k}>
              <button
                type="button"
                onClick={() => onSelect(c)}
                className={`flex w-full items-center gap-3 px-4 text-left transition-colors ${
                  dense ? 'py-2' : 'py-2.5'
                } ${selected ? 'bg-bg-subtle' : 'hover:bg-bg-subtle'}`}
                data-testid={`conversation-item-${c.type.toLowerCase()}`}
              >
                <ConversationBadge conv={c} size={size} online={online} />
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
                    <span className="truncate text-xs text-text-muted">{previewOf(c)}</span>
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
