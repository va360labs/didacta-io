'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { communityApi, type PostDetail, type Reaction } from '@/lib/community';

const EMOJIS = ['👍', '❤️', '🎉', '🤔'];

export default function PostDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [post, setPost] = useState<PostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const myUserId = authStorage.getSession()?.user.id;

  async function reload() {
    if (!params?.id) return;
    try {
      setPost(await communityApi.getPost(params.id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al cargar el post');
    }
  }

  useEffect(() => {
    void reload();
  }, [params?.id]);

  async function handleAddComment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!post || !commentBody.trim()) return;
    setPending(true);
    try {
      await communityApi.addComment(post.id, commentBody);
      setCommentBody('');
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al comentar');
    } finally {
      setPending(false);
    }
  }

  async function handleDeletePost() {
    if (!post) return;
    if (!window.confirm('¿Eliminar este post? Solo el autor puede.')) return;
    setPending(true);
    try {
      await communityApi.deletePost(post.id);
      router.push('/comunidad');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al eliminar');
      setPending(false);
    }
  }

  async function handleReactPost(emoji: string) {
    if (!post) return;
    setPending(true);
    try {
      const existing = post.reactions.find(
        (r) => r.postId === post.id && r.authorId === myUserId && r.emoji === emoji,
      );
      if (existing) {
        await communityApi.removeReaction(existing.id);
      } else {
        await communityApi.addReactionToPost(post.id, emoji);
      }
      await reload();
    } finally {
      setPending(false);
    }
  }

  async function handleReactComment(commentId: string, emoji: string) {
    if (!post) return;
    setPending(true);
    try {
      const existing = post.reactions.find(
        (r) => r.commentId === commentId && r.authorId === myUserId && r.emoji === emoji,
      );
      if (existing) {
        await communityApi.removeReaction(existing.id);
      } else {
        await communityApi.addReactionToComment(commentId, emoji);
      }
      await reload();
    } finally {
      setPending(false);
    }
  }

  async function handleDeleteComment(id: string) {
    if (!window.confirm('¿Eliminar este comentario?')) return;
    setPending(true);
    try {
      await communityApi.deleteComment(id);
      await reload();
    } finally {
      setPending(false);
    }
  }

  if (error && !post)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!post) return <p className="text-sm text-neutral-500">Cargando…</p>;

  const isAuthor = post.authorId === myUserId;
  const postReactions = groupReactions(post.reactions.filter((r) => r.postId === post.id));

  return (
    <section className="space-y-6">
      <Link
        href="/comunidad"
        className="text-xs text-neutral-500 underline decoration-dotted hover:decoration-solid"
      >
        ← Volver a la comunidad
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{post.title}</CardTitle>
          <CardDescription>
            por {post.authorDisplayName ?? 'anónimo'} · {new Date(post.createdAt).toLocaleString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
            {post.body}
          </p>
          {post.tags.length > 0 ? (
            <p>
              {post.tags.map((t) => (
                <span
                  key={t}
                  className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  #{t}
                </span>
              ))}
            </p>
          ) : null}
          <div className="flex items-center gap-2 pt-2">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => handleReactPost(e)}
                disabled={pending}
                className="rounded-md border border-neutral-200 px-2 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                {e} {postReactions[e] ?? 0}
              </button>
            ))}
          </div>
          {isAuthor ? (
            <button
              type="button"
              onClick={handleDeletePost}
              disabled={pending}
              className="text-xs text-red-600 underline decoration-dotted hover:decoration-solid"
            >
              Eliminar post
            </button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {post.comments.length} comentario{post.comments.length === 1 ? '' : 's'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {post.comments.map((c) => {
            const cReactions = groupReactions(post.reactions.filter((r) => r.commentId === c.id));
            const isCommentAuthor = c.authorId === myUserId;
            return (
              <div
                key={c.id}
                className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <p className="whitespace-pre-wrap text-sm">{c.body}</p>
                <p className="mt-2 text-xs text-neutral-500">
                  {c.authorDisplayName ?? 'anónimo'} · {new Date(c.createdAt).toLocaleString()}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  {EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => handleReactComment(c.id, e)}
                      disabled={pending}
                      className="rounded-md border border-neutral-200 px-2 py-0.5 text-xs hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                    >
                      {e} {cReactions[e] ?? 0}
                    </button>
                  ))}
                  {isCommentAuthor ? (
                    <button
                      type="button"
                      onClick={() => handleDeleteComment(c.id)}
                      disabled={pending}
                      className="ml-auto text-xs text-red-600 underline decoration-dotted hover:decoration-solid"
                    >
                      Eliminar
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}

          <form onSubmit={handleAddComment} className="space-y-2">
            <Textarea
              rows={3}
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Escribí un comentario…"
              required
            />
            <Button type="submit" size="sm" disabled={pending || !commentBody.trim()}>
              {pending ? 'Enviando…' : 'Comentar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

function groupReactions(reactions: Reaction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reactions) out[r.emoji] = (out[r.emoji] ?? 0) + 1;
  return out;
}
