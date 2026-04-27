'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { cn } from '@/lib/utils';
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar el post.');
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
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos publicar el comentario.');
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
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos eliminar el post.');
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
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">{error}</CardContent>
      </Card>
    );
  if (!post) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-32" />
        <div className="skeleton h-48 w-full" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  const isAuthor = post.authorId === myUserId;
  const postReactions = groupReactions(post.reactions.filter((r) => r.postId === post.id));
  const myReactionsForPost = new Set(
    post.reactions
      .filter((r) => r.postId === post.id && r.authorId === myUserId)
      .map((r) => r.emoji),
  );
  const initials = (post.authorDisplayName ?? 'A')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <section className="space-y-6">
      <Link
        href="/comunidad"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text"
      >
        <span aria-hidden="true">←</span>
        Volver a la comunidad
      </Link>

      {/* Post hero */}
      <Card>
        <CardContent className="p-6">
          <div className="flex gap-4">
            <div
              aria-hidden="true"
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full font-display text-base font-bold text-white"
              style={{
                background: 'linear-gradient(135deg, #1E5AA8 0%, #18B5A8 100%)',
              }}
            >
              {initials || 'A'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-text">
                  {post.authorDisplayName ?? 'Anónimo'}
                </span>
                {post.tags.slice(0, 3).map((t) => (
                  <Badge key={t} variant="info">
                    {t}
                  </Badge>
                ))}
                <span className="text-xs text-text-subtle">{relTime(post.createdAt)}</span>
              </div>
              <h1
                className="font-display mt-3 text-3xl font-bold leading-tight text-text"
                style={{ letterSpacing: '-0.02em' }}
              >
                {post.title}
              </h1>
              <p className="mt-3 whitespace-pre-wrap text-base leading-relaxed text-text">
                {post.body}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {EMOJIS.map((e) => {
                  const mine = myReactionsForPost.has(e);
                  const count = postReactions[e] ?? 0;
                  return (
                    <button
                      key={e}
                      type="button"
                      onClick={() => handleReactPost(e)}
                      disabled={pending}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
                        mine
                          ? 'border-[rgba(46,125,206,0.32)] bg-[var(--didacta-info-bg)] text-[var(--didacta-info-fg)]'
                          : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text',
                      )}
                    >
                      <span>{e}</span>
                      {count > 0 ? <span className="tabular-nums">{count}</span> : null}
                    </button>
                  );
                })}
                {isAuthor ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleDeletePost}
                    disabled={pending}
                    className="ml-auto text-danger-700 hover:bg-danger-50"
                  >
                    Eliminar post
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Comments */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2
            className="font-display text-xl font-semibold text-text"
            style={{ letterSpacing: '-0.01em' }}
          >
            {post.comments.length} respuesta{post.comments.length === 1 ? '' : 's'}
          </h2>
        </div>

        <Card className="mb-4">
          <CardContent className="p-5">
            <form onSubmit={handleAddComment} className="space-y-3">
              <Textarea
                rows={3}
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="Aportá tu respuesta…"
                required
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={pending || !commentBody.trim()}>
                  <Icon name="message" size={16} />
                  {pending ? 'Enviando…' : 'Responder'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {post.comments.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-sm text-text-muted">
                Aún no hay respuestas. Aportá vos la primera.
              </CardContent>
            </Card>
          ) : (
            post.comments.map((c) => {
              const cReactions = groupReactions(post.reactions.filter((r) => r.commentId === c.id));
              const myCommentReactions = new Set(
                post.reactions
                  .filter((r) => r.commentId === c.id && r.authorId === myUserId)
                  .map((r) => r.emoji),
              );
              const isCommentAuthor = c.authorId === myUserId;
              const cInitials = (c.authorDisplayName ?? 'A')
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((s) => s[0]?.toUpperCase() ?? '')
                .join('');
              return (
                <Card key={c.id}>
                  <CardContent className="p-5">
                    <div className="flex gap-3">
                      <div
                        aria-hidden="true"
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-full font-display text-xs font-bold text-white"
                        style={{
                          background: 'linear-gradient(135deg, #1E5AA8 0%, #18B5A8 100%)',
                        }}
                      >
                        {cInitials || 'A'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-text">
                            {c.authorDisplayName ?? 'Anónimo'}
                          </span>
                          <span className="text-xs text-text-subtle">{relTime(c.createdAt)}</span>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text">
                          {c.body}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          {EMOJIS.map((e) => {
                            const mine = myCommentReactions.has(e);
                            const count = cReactions[e] ?? 0;
                            return (
                              <button
                                key={e}
                                type="button"
                                onClick={() => handleReactComment(c.id, e)}
                                disabled={pending}
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
                                  mine
                                    ? 'border-[rgba(46,125,206,0.32)] bg-[var(--didacta-info-bg)] text-[var(--didacta-info-fg)]'
                                    : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text',
                                )}
                              >
                                <span>{e}</span>
                                {count > 0 ? <span className="tabular-nums">{count}</span> : null}
                              </button>
                            );
                          })}
                          {isCommentAuthor ? (
                            <button
                              type="button"
                              onClick={() => handleDeleteComment(c.id)}
                              disabled={pending}
                              className="ml-auto text-xs text-danger-700 hover:underline"
                            >
                              Eliminar
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

function groupReactions(reactions: Reaction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reactions) out[r.emoji] = (out[r.emoji] ?? 0) + 1;
  return out;
}

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `hace ${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
}
