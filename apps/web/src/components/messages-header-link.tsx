'use client';

import { Icon } from '@/components/icon';
import { useMessagingContext } from '@/components/messaging-provider';

/**
 * Icono de Mensajes del header con badge de conversaciones no leídas,
 * alimentado en tiempo real por el MessagingProvider.
 */
export function MessagesHeaderLink() {
  const { unreadConversations } = useMessagingContext();
  return (
    <a
      href="/mensajes"
      className="relative grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-text-muted transition-colors hover:border-border-strong hover:text-text"
      aria-label={
        unreadConversations > 0
          ? `Mensajes (${unreadConversations} conversaciones sin leer)`
          : 'Mensajes'
      }
      data-testid="messages-header-link"
    >
      <Icon name="messages" size={18} />
      {unreadConversations > 0 ? (
        <span
          className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-danger-500 px-1 text-[10px] font-bold leading-none text-white"
          data-testid="messages-unread-badge"
        >
          {unreadConversations > 99 ? '99+' : unreadConversations}
        </span>
      ) : null}
    </a>
  );
}
