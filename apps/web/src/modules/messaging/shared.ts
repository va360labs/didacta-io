/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError } from '@/lib/api-client';
import { formatDate, formatTime } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';
import type { ConversationView } from './client';

/** Piezas compartidas por la página `/mensajes` y el chat flotante. */

export const STAFF_ROLES = ['formador', 'tenant_admin', 'super_admin'];

/** Clave estable en la lista (las salas sin materializar no tienen id). */
export function keyOf(conversation: ConversationView): string {
  return conversation.id ?? `space:${conversation.space?.slug ?? conversation.title}`;
}

/** `t` = `useTranslations('modMessaging')` del componente que llama. */
export function dayLabel(iso: string, t: TranslatorLike): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return t('dayToday');
  if (sameDay(d, yesterday)) return t('dayYesterday');
  return formatDate(d, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function timeLabel(iso: string): string {
  return formatTime(iso, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Tiempo relativo corto de la bandeja («ahora», «hace 5m»…); a partir de una
 * semana, fecha corta.
 *
 * Copia propia del módulo a propósito: `relTime` de
 * `components/community-thread-card` recibe su `t` del namespace
 * `comunidadComponentes`, que no es el de esta unidad, y su firma (con `t`
 * OPCIONAL) devolvería español si se la llamara sin traductor. Aquí `t` es
 * OBLIGATORIO: la bandeja no puede degradar a español en silencio.
 */
export function relTime(iso: string, t: TranslatorLike): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff >= 86400 * 7) return formatDate(iso, { day: '2-digit', month: 'short' });
  if (diff < 60) return t('relTimeNow');
  if (diff < 3600) return t('relTimeMinutes', { minutes: Math.floor(diff / 60) });
  if (diff < 86400) return t('relTimeHours', { hours: Math.floor(diff / 3600) });
  return t('relTimeDays', { days: Math.floor(diff / 86400) });
}

/**
 * `t` = `useTranslations('modMessaging')`, y es OBLIGATORIO: los 6 call-sites
 * (los 4 de `use-conversation-thread` y los 2 de `/mensajes`) le pasan el suyo.
 * No hay rama degradada a español — un `t` opcional aquí significaba español en
 * la UI inglesa sin que fallara ningún test.
 */
export function humanizeError(e: unknown, t: TranslatorLike): string {
  if (!(e instanceof ApiHttpError)) return t('errorLoad');
  switch (e.code) {
    case 'MESSAGING_NOT_PARTICIPANT':
      return t('errorNotParticipant');
    case 'MESSAGING_CONVERSATION_NOT_FOUND':
      return t('errorConversationNotFound');
    case 'MESSAGING_BODY_INVALID':
      return t('errorBodyInvalid');
    case 'MESSAGING_SELF_DM':
      return t('errorSelfDm');
    case 'MESSAGING_RATE_LIMITED':
      return t('errorRateLimited');
    default:
      if (e.status !== 403) return e.message;
      return t('errorModuleInactive');
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
export function previewOf(conversation: ConversationView, t: TranslatorLike): string {
  const last = conversation.lastMessage;
  if (!last) return t('previewEmpty');
  const author = last.authorDisplayName ? `${last.authorDisplayName}: ` : '';
  return `${author}${last.body || t('previewDeleted')}`;
}
