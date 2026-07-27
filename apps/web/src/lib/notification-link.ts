/**
 * Mapea una notificación (templateKey + metadata) a un destino navegable dentro
 * de la app. Lo comparten la lista `/notificaciones` y el toast en vivo para que
 * "ir directamente a responder" sea un único lugar de verdad.
 *
 * Devuelve `null` cuando la notificación no tiene una acción de navegación
 * asociada (p. ej. avisos de sistema) — el consumidor la muestra sin enlace.
 */
import { postPath } from './post-link';

export interface NotificationLink {
  href: string;
  actionLabel: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function notificationLink(
  templateKey: string,
  metadata: Record<string, unknown> | null | undefined,
): NotificationLink | null {
  const meta = metadata ?? {};
  const postId = str(meta.postId);

  switch (templateKey) {
    case 'community.comment.on_post': {
      // Comentaron en tu publicación → abrí el hilo enfocado en ese comentario.
      if (!postId) return null;
      const commentId = str(meta.commentId);
      return {
        href: postPath(postId, { commentId: commentId ?? undefined }),
        actionLabel: 'Responder',
      };
    }
    case 'community.reply.to_comment': {
      // Respondieron a tu comentario → enfocá tu comentario (el padre) para
      // seguir la conversación; si no vino el padre, caé al nuevo comentario.
      if (!postId) return null;
      const focusId = str(meta.parentCommentId) ?? str(meta.commentId);
      return {
        href: postPath(postId, { commentId: focusId ?? undefined }),
        actionLabel: 'Responder',
      };
    }
    case 'community.mention': {
      if (!postId) return null;
      const commentId = str(meta.commentId);
      return {
        href: postPath(postId, { commentId: commentId ?? undefined }),
        actionLabel: 'Ver',
      };
    }
    default:
      return null;
  }
}
