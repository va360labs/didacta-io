/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { TranslatorLike } from '@/lib/i18n/labels';
import type { ConversationView } from './client';
import type { TypingSignal } from './messaging-provider';

/**
 * Derivación PURA del contenido de la píldora del chat flotante. Vive aparte del
 * componente a propósito: toda la prioridad del copy y el orden de las caras se
 * prueba sin montar DOM.
 *
 * Regla #3 — aquí no se inventa nada: si no hay dato, el estado es vacío y la
 * píldora lo dice.
 */

/** Nº máximo de caras apiladas en la píldora. */
export const PILL_MAX_AVATARS = 3;

export type PillLineKind = 'typing' | 'unread' | 'idle';

export interface PillLine {
  kind: PillLineKind;
  /**
   * Texto plano de la línea, SIN espacio final: quien la pinta añade el
   * separador antes de `target` (un espacio load-bearing dentro de un valor
   * del catálogo se pierde en cuanto alguien reformatea el JSON).
   */
  prefix: string;
  /** Destino destacado en color (`#sala` o nombre). `null` si la línea no lo tiene. */
  target: string | null;
}

export interface PillState {
  /** Ids de los últimos autores, más reciente primero (máx. `PILL_MAX_AVATARS`). */
  avatarUserIds: string[];
  line1: PillLine;
  /** Resumen agregado. `null` cuando no hay nada que resumir. */
  line2: string | null;
  /** Conversaciones con no-leídos (badge de la píldora colapsada en móvil). */
  unreadConversations: number;
}

export interface PillInput {
  conversations: ConversationView[] | null;
  typing: TypingSignal[];
  /** Se excluye de las caras: nadie necesita verse a sí mismo. */
  viewerId: string;
  now: number;
}

/** Etiqueta de una conversación tal como se nombra en la píldora. */
function labelOf(conversation: ConversationView): { text: string; isRoom: boolean } {
  if (conversation.type === 'SPACE') {
    // El slug se lee como canal (`#general`), que es justo lo que es.
    return { text: `#${conversation.space?.slug ?? conversation.title}`, isRoom: true };
  }
  return { text: conversation.title, isRoom: false };
}

/** `t` = `useTranslations('modMessaging')` del componente que la llama. */
export function derivePillState(
  { conversations, typing, viewerId, now }: PillInput,
  t: TranslatorLike,
): PillState {
  const list = conversations ?? [];
  const byId = new Map(list.filter((c) => c.id !== null).map((c) => [c.id as string, c]));

  // ── Señal de escritura viva más reciente ─────────────────────────────────
  const liveTyping = typing
    .filter((t) => t.expiresAt > now && t.userId !== viewerId)
    .sort((a, b) => b.expiresAt - a.expiresAt);
  const topTyping = liveTyping[0] ?? null;

  // ── Caras: últimos autores distintos, más reciente primero ───────────────
  // Quien está escribiendo AHORA es, por definición, lo más reciente: va delante.
  const avatarUserIds: string[] = [];
  const pushAuthor = (userId: string | null | undefined) => {
    if (!userId || userId === viewerId) return;
    if (avatarUserIds.includes(userId)) return;
    if (avatarUserIds.length >= PILL_MAX_AVATARS) return;
    avatarUserIds.push(userId);
  };
  for (const t of liveTyping) pushAuthor(t.userId);
  const byRecency = [...list].sort((a, b) =>
    (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''),
  );
  for (const c of byRecency) pushAuthor(c.lastMessage?.authorId);

  // ── Línea 1, por prioridad estricta ──────────────────────────────────────
  let line1: PillLine;
  const unread = byRecency.filter((c) => c.unreadCount > 0);
  const topUnread = unread[0] ?? null;

  if (topTyping) {
    const conversation = byId.get(topTyping.conversationId) ?? null;
    const who = topTyping.displayName?.trim() || t('someone');
    if (conversation) {
      const label = labelOf(conversation);
      line1 = label.isRoom
        ? { kind: 'typing', prefix: t('pillTypingRoom', { who }), target: label.text }
        : { kind: 'typing', prefix: t('pillTypingDm', { who }), target: null };
    } else {
      // Conversación fuera de la lista (p. ej. sala que este usuario no tiene
      // materializada): se nombra a la persona, nunca una sala inventada.
      line1 = { kind: 'typing', prefix: t('pillTypingUnknown', { who }), target: null };
    }
  } else if (topUnread) {
    const label = labelOf(topUnread);
    const count = topUnread.unreadCount;
    line1 = label.isRoom
      ? { kind: 'unread', prefix: t('pillUnreadRoom', { count }), target: label.text }
      : { kind: 'unread', prefix: t('pillUnreadDm', { count }), target: label.text };
  } else {
    line1 = { kind: 'idle', prefix: t('pillIdle'), target: null };
  }

  // ── Línea 2: resumen agregado ────────────────────────────────────────────
  // Solo aparece cuando hay algo pendiente. Con todo leído, «7 salas» no
  // informaba de nada y dejaba la píldora con dos líneas desparejadas: en
  // reposo se queda en una sola línea.
  const rooms = list.filter((c) => c.type === 'SPACE').length;
  const unreadCount = unread.length;
  const hasAnyMessage = list.some((c) => c.lastMessage !== null);

  let line2: string | null;
  if (!hasAnyMessage) {
    line2 = conversations === null ? null : t('pillStartConversation');
  } else if (unreadCount > 0) {
    line2 =
      rooms > 0
        ? t('pillSummaryWithRooms', { rooms, unread: unreadCount })
        : t('pillSummary', { unread: unreadCount });
  } else {
    line2 = null;
  }

  return { avatarUserIds, line1, line2, unreadConversations: unreadCount };
}
