import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/**
 * Cliente API de mod.messaging. Tipos espejo de los views del backend
 * (modules/messaging/src/messaging.service.ts).
 */

export interface MessagingPublicUser {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

export type ConversationType = 'SPACE' | 'DM' | 'FACULTY';

export interface ConversationView {
  /** Null solo en salas de espacio aún sin materializar (sin mensajes). */
  id: string | null;
  type: ConversationType;
  title: string;
  space: { slug: string; icon: string; color: string } | null;
  counterpart: MessagingPublicUser | null;
  lastMessage: {
    body: string;
    kind: string;
    authorDisplayName: string | null;
    createdAt: string;
  } | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface MessageView {
  id: string;
  conversationId: string;
  authorId: string;
  authorDisplayName: string | null;
  kind: string;
  body: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface MessagesPage {
  messages: MessageView[];
  nextCursor: string | null;
}

/** Evento del stream SSE de mensajería (discriminador `kind` en el JSON). */
export type MessagingStreamEvent =
  | { kind: 'message.created'; conversationId: string; message: MessageView }
  | { kind: 'ping'; t: number };

const BASE = '/api/v1/modules/messaging';

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const messagingApi = {
  async listConversations(): Promise<{ conversations: ConversationView[] }> {
    return apiFetch<{ conversations: ConversationView[] }>(
      `${BASE}/conversations`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async openDm(userId: string): Promise<{ conversationId: string; created: boolean }> {
    return apiFetch<{ conversationId: string; created: boolean }>(
      `${BASE}/dm`,
      { method: 'POST', body: JSON.stringify({ userId }) },
      withAuth(),
    );
  },

  async openSpace(slug: string): Promise<{ conversationId: string }> {
    return apiFetch<{ conversationId: string }>(
      `${BASE}/spaces/${encodeURIComponent(slug)}/open`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  async openFaculty(): Promise<{ conversationId: string }> {
    return apiFetch<{ conversationId: string }>(
      `${BASE}/faculty/open`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  async listMessages(conversationId: string, cursor?: string): Promise<MessagesPage> {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return apiFetch<MessagesPage>(
      `${BASE}/conversations/${conversationId}/messages${qs}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async sendMessage(conversationId: string, body: string): Promise<{ message: MessageView }> {
    return apiFetch<{ message: MessageView }>(
      `${BASE}/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ body }) },
      withAuth(),
    );
  },

  async markRead(conversationId: string): Promise<void> {
    await apiFetch<{ ok: true }>(
      `${BASE}/conversations/${conversationId}/read`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  async searchMembers(search: string): Promise<{ members: MessagingPublicUser[] }> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    return apiFetch<{ members: MessagingPublicUser[] }>(
      `${BASE}/members${qs}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async getStreamTicket(): Promise<{ ticket: string }> {
    // body '{}' obligatorio: Fastify rechaza Content-Type sin body.
    return apiFetch<{ ticket: string }>(
      `${BASE}/stream-ticket`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
};
