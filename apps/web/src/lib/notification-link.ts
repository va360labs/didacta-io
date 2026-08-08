/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Mapea una notificación (templateKey + metadata) a un destino navegable dentro
 * de la app. Lo comparten la lista `/notificaciones` y el toast en vivo para que
 * "ir directamente a responder" sea un único lugar de verdad.
 *
 * Devuelve `null` cuando la notificación no tiene una acción de navegación
 * asociada (p. ej. avisos de sistema) — el consumidor la muestra sin enlace.
 */
import type { TranslatorLike } from './i18n/labels';
import { postPath } from './post-link';

export interface NotificationLink {
  href: string;
  actionLabel: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `t` = `useTranslations('libShared')` del componente que la llama.
 *
 * Va OPCIONAL solo por compatibilidad: `/notificaciones` y el toaster
 * pertenecen a otras unidades de la migración y todavía la llaman sin
 * traductor. Sin `t` devuelve el español cableado de siempre (nunca una key en
 * pantalla). Cuando esos dos pasen el suyo, `t` pasa a obligatorio.
 */
export function notificationLink(
  templateKey: string,
  metadata: Record<string, unknown> | null | undefined,
  t?: TranslatorLike,
): NotificationLink | null {
  const meta = metadata ?? {};
  const postId = str(meta.postId);
  const reply = t ? t('notificationAction.reply') : 'Responder';
  const view = t ? t('notificationAction.view') : 'Ver';

  switch (templateKey) {
    case 'community.comment.on_post': {
      // Comentaron en tu publicación → abrí el hilo enfocado en ese comentario.
      if (!postId) return null;
      const commentId = str(meta.commentId);
      return {
        href: postPath(postId, { commentId: commentId ?? undefined }),
        actionLabel: reply,
      };
    }
    case 'community.reply.to_comment': {
      // Respondieron a tu comentario → enfocá tu comentario (el padre) para
      // seguir la conversación; si no vino el padre, caé al nuevo comentario.
      if (!postId) return null;
      const focusId = str(meta.parentCommentId) ?? str(meta.commentId);
      return {
        href: postPath(postId, { commentId: focusId ?? undefined }),
        actionLabel: reply,
      };
    }
    case 'community.mention': {
      if (!postId) return null;
      const commentId = str(meta.commentId);
      return {
        href: postPath(postId, { commentId: commentId ?? undefined }),
        actionLabel: view,
      };
    }
    default:
      return null;
  }
}
