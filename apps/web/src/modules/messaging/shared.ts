/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError } from '@/lib/api-client';
import type { ConversationView } from './client';

/** Piezas compartidas por la página `/mensajes` y el chat flotante. */

export const STAFF_ROLES = ['formador', 'tenant_admin', 'super_admin'];

/** Clave estable en la lista (las salas sin materializar no tienen id). */
export function keyOf(conversation: ConversationView): string {
  return conversation.id ?? `space:${conversation.space?.slug ?? conversation.title}`;
}

export function dayLabel(iso: string): string {
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

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

export function humanizeError(e: unknown): string {
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
    case 'MESSAGING_RATE_LIMITED':
      return 'Vas demasiado rápido. Espera unos segundos y vuelve a intentarlo.';
    default:
      return e.status === 403
        ? 'El módulo de mensajería no está activo en esta comunidad.'
        : e.message;
  }
}

export interface ConversationGroups {
  salas: ConversationView[];
  profesores: ConversationView[];
  directos: ConversationView[];
}

/** Los tres grupos de la bandeja, en el orden en el que se pintan. */
export function groupConversations(list: ConversationView[]): ConversationGroups {
  return {
    salas: list.filter((c) => c.type === 'SPACE'),
    profesores: list.filter((c) => c.type === 'FACULTY'),
    directos: list.filter((c) => c.type === 'DM'),
  };
}

/** Texto de una fila: «Autor: cuerpo», o el placeholder que toque. */
export function previewOf(conversation: ConversationView): string {
  const last = conversation.lastMessage;
  if (!last) return 'Sin mensajes todavía';
  const author = last.authorDisplayName ? `${last.authorDisplayName}: ` : '';
  return `${author}${last.body || '(mensaje eliminado)'}`;
}
