import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import es from '@/i18n/messages/es';
import en from '@/i18n/messages/en';
import { notificationLink } from './notification-link';

const tEs = createTranslator({ locale: 'es-ES', messages: es, namespace: 'libShared' });
const tEn = createTranslator({ locale: 'en-US', messages: en, namespace: 'libShared' });

describe('notificationLink', () => {
  it('comentario en post → hilo enfocado en el comentario con acción Responder', () => {
    expect(
      notificationLink('community.comment.on_post', { postId: 'p1', commentId: 'c1' }, tEs),
    ).toEqual({ href: '/comunidad/p1?comment=c1', actionLabel: 'Responder' });
  });

  it('respuesta → enfoca el comentario padre (para seguir la conversación)', () => {
    expect(
      notificationLink(
        'community.reply.to_comment',
        { postId: 'p1', commentId: 'c2', parentCommentId: 'c1' },
        tEs,
      ),
    ).toEqual({ href: '/comunidad/p1?comment=c1', actionLabel: 'Responder' });
  });

  it('respuesta sin parentCommentId cae al nuevo comentario', () => {
    expect(
      notificationLink('community.reply.to_comment', { postId: 'p1', commentId: 'c2' }, tEs),
    ).toEqual({ href: '/comunidad/p1?comment=c2', actionLabel: 'Responder' });
  });

  it('mención → acción Ver', () => {
    expect(notificationLink('community.mention', { postId: 'p1', commentId: 'c1' }, tEs)).toEqual({
      href: '/comunidad/p1?comment=c1',
      actionLabel: 'Ver',
    });
  });

  it('comentario sin postId → sin enlace (null)', () => {
    expect(notificationLink('community.comment.on_post', {}, tEs)).toBeNull();
  });

  it('templateKey no navegable → null', () => {
    expect(notificationLink('enrollment.created', { course: 'x' }, tEs)).toBeNull();
  });

  it('metadata ausente → null sin lanzar', () => {
    expect(notificationLink('community.comment.on_post', undefined, tEs)).toBeNull();
    expect(notificationLink('community.comment.on_post', null, tEs)).toBeNull();
  });

  it('la acción sale del catálogo en los dos idiomas (MUST-FIX 25)', () => {
    const meta = { postId: 'p1', commentId: 'c1' };
    expect(notificationLink('community.comment.on_post', meta, tEs)?.actionLabel).toBe('Responder');
    expect(notificationLink('community.comment.on_post', meta, tEn)?.actionLabel).toBe('Reply');
    expect(notificationLink('community.mention', meta, tEs)?.actionLabel).toBe('Ver');
    expect(notificationLink('community.mention', meta, tEn)?.actionLabel).toBe('View');
  });
});
