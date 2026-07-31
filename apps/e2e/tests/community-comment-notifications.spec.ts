import { expect, test } from '@playwright/test';
import { API_URL, signup } from '../helpers/api';

/**
 * Spec end-to-end de notificaciones de comentarios/respuestas.
 *
 * Cubre:
 * - Usuario B comenta el post de A → A recibe una notificación IN_APP
 *   `community.comment.on_post` con el postId en metadata.
 * - Usuario C responde al comentario de B → B recibe `community.reply.to_comment`.
 * - Comentar el propio post NO genera notificación (no auto-aviso).
 */

interface AuthedUser {
  user: { id: string };
  tokens: { accessToken: string };
}

interface NotificationRow {
  templateKey: string;
  readAt: string | null;
  metadata?: Record<string, unknown>;
}

async function createPost(token: string, title: string, body: string): Promise<{ id: string }> {
  const res = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  });
  expect(res.ok, `post creado (got ${res.status})`).toBe(true);
  return (await res.json()) as { id: string };
}

async function addComment(
  token: string,
  postId: string,
  body: string,
  parentCommentId?: string,
): Promise<{ id: string }> {
  const res = await fetch(`${API_URL}/api/v1/modules/community/posts/${postId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, ...(parentCommentId ? { parentCommentId } : {}) }),
  });
  expect(res.ok, `comentario creado (got ${res.status})`).toBe(true);
  return (await res.json()) as { id: string };
}

async function notifications(token: string): Promise<NotificationRow[]> {
  const res = await fetch(`${API_URL}/api/v1/me/notifications`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as NotificationRow[];
}

test.describe('mod.community · notificaciones de comentarios y respuestas', () => {
  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';

  test('comentar el post de otro notifica al autor (community.comment.on_post)', async () => {
    const stamp = Date.now();
    const author = (await signup({
      tenantSlug,
      email: `e2e-cn-author-${stamp}@example.test`,
      password: 'E2eCommentA123!',
      name: 'Autor CN',
    })) as AuthedUser;
    const commenter = (await signup({
      tenantSlug,
      email: `e2e-cn-commenter-${stamp}@example.test`,
      password: 'E2eCommentB123!',
      name: 'Coment CN',
    })) as AuthedUser;

    const post = await createPost(author.tokens.accessToken, `Post CN ${stamp}`, 'contenido base');
    await addComment(commenter.tokens.accessToken, post.id, 'buen aporte, gracias por compartir');

    const list = await notifications(author.tokens.accessToken);
    const notif = list.find(
      (n) => n.templateKey === 'community.comment.on_post' && n.metadata?.postId === post.id,
    );
    expect(notif, 'el autor del post recibe la notificación del comentario').toBeDefined();
    expect(notif!.readAt).toBeNull();
  });

  test('responder a un comentario notifica a su autor (community.reply.to_comment)', async () => {
    const stamp = Date.now();
    const author = (await signup({
      tenantSlug,
      email: `e2e-cn-pa-${stamp}@example.test`,
      password: 'E2eReplyA123!',
      name: 'Autor',
    })) as AuthedUser;
    const commenter = (await signup({
      tenantSlug,
      email: `e2e-cn-pb-${stamp}@example.test`,
      password: 'E2eReplyB123!',
      name: 'Coment',
    })) as AuthedUser;
    const replier = (await signup({
      tenantSlug,
      email: `e2e-cn-pc-${stamp}@example.test`,
      password: 'E2eReplyC123!',
      name: 'Rep',
    })) as AuthedUser;

    const post = await createPost(author.tokens.accessToken, `Post reply ${stamp}`, 'contenido');
    const root = await addComment(commenter.tokens.accessToken, post.id, 'primer comentario');
    await addComment(replier.tokens.accessToken, post.id, 'te respondo a esto', root.id);

    const list = await notifications(commenter.tokens.accessToken);
    const notif = list.find(
      (n) => n.templateKey === 'community.reply.to_comment' && n.metadata?.postId === post.id,
    );
    expect(notif, 'el comentarista recibe la notificación de la respuesta').toBeDefined();
    expect(notif!.metadata?.parentCommentId).toBe(root.id);
  });

  test('comentar el propio post no genera notificación', async () => {
    const stamp = Date.now();
    const author = (await signup({
      tenantSlug,
      email: `e2e-cn-self-${stamp}@example.test`,
      password: 'E2eSelf123!aa',
      name: 'Autor Self',
    })) as AuthedUser;

    const post = await createPost(author.tokens.accessToken, `Post self ${stamp}`, 'contenido');
    await addComment(author.tokens.accessToken, post.id, 'me auto-comento');

    const list = await notifications(author.tokens.accessToken);
    expect(
      list.some(
        (n) => n.templateKey === 'community.comment.on_post' && n.metadata?.postId === post.id,
      ),
      'no hay auto-notificación',
    ).toBe(false);
  });
});
