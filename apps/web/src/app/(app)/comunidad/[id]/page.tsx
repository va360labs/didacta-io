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
import { communityApi, type Comment, type PostDetail, type Reaction } from '@/lib/community';

const EMOJIS = ['👍', '❤️', '🎉', '🤔'];

export default function PostDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [post, setPost] = useState<PostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  /** Si está set, el form de respuesta inline está abierto bajo este comment. */
  const [replyTarget, setReplyTarget] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const myUserId = authStorage.getSession()?.user.id;
  const myRoles = authStorage.getSession()?.user.roles ?? [];
  const canModerate = myRoles.includes('super_admin') || myRoles.includes('tenant_admin');

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

  async function handleReply(parentCommentId: string) {
    if (!post || !replyBody.trim()) return;
    setPending(true);
    try {
      await communityApi.addComment(post.id, replyBody, parentCommentId);
      setReplyBody('');
      setReplyTarget(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos publicar la respuesta.');
    } finally {
      setPending(false);
    }
  }

  async function handleModeratePost() {
    if (!post) return;
    const isHidden = post.hiddenAt !== null;
    if (isHidden) {
      if (!window.confirm('¿Restaurar este post? Volverá a ser visible para los alumnos.')) return;
      setPending(true);
      try {
        await communityApi.moderatePost(post.id, false);
        await reload();
      } catch (err) {
        setError(err instanceof ApiHttpError ? err.message : 'No pudimos restaurar el post.');
      } finally {
        setPending(false);
      }
    } else {
      const reason = window.prompt('Motivo de ocultar el post (opcional):') ?? undefined;
      setPending(true);
      try {
        await communityApi.moderatePost(post.id, true, reason || undefined);
        await reload();
      } catch (err) {
        setError(err instanceof ApiHttpError ? err.message : 'No pudimos ocultar el post.');
      } finally {
        setPending(false);
      }
    }
  }

  async function handleModerateComment(commentId: string, isHidden: boolean) {
    if (isHidden) {
      if (!window.confirm('¿Restaurar este comentario?')) return;
      setPending(true);
      try {
        await communityApi.moderateComment(commentId, false);
        await reload();
      } catch (err) {
        setError(err instanceof ApiHttpError ? err.message : 'No pudimos restaurar.');
      } finally {
        setPending(false);
      }
    } else {
      const reason = window.prompt('Motivo de ocultar el comentario (opcional):') ?? undefined;
      setPending(true);
      try {
        await communityApi.moderateComment(commentId, true, reason || undefined);
        await reload();
      } catch (err) {
        setError(err instanceof ApiHttpError ? err.message : 'No pudimos ocultar.');
      } finally {
        setPending(false);
      }
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
                {post.hiddenAt ? (
                  <Badge variant="warning" dot>
                    Oculto
                  </Badge>
                ) : null}
              </div>
              {post.hiddenAt && post.hiddenReason ? (
                <p className="mt-2 rounded-md bg-warning-50 px-3 py-1.5 text-xs text-warning-700">
                  Motivo: {post.hiddenReason}
                </p>
              ) : null}
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
                {canModerate ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleModeratePost}
                    disabled={pending}
                    className="ml-auto"
                  >
                    {post.hiddenAt ? 'Restaurar post' : 'Ocultar post'}
                  </Button>
                ) : null}
                {isAuthor ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleDeletePost}
                    disabled={pending}
                    className={
                      canModerate
                        ? 'text-danger-700 hover:bg-danger-50'
                        : 'ml-auto text-danger-700 hover:bg-danger-50'
                    }
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

        <CommentsSection
          comments={post.comments}
          reactions={post.reactions}
          myUserId={myUserId}
          pending={pending}
          replyTarget={replyTarget}
          replyBody={replyBody}
          onReplyOpen={(id) => {
            setReplyTarget(id);
            setReplyBody('');
          }}
          onReplyClose={() => {
            setReplyTarget(null);
            setReplyBody('');
          }}
          onReplyChange={setReplyBody}
          onReplySubmit={handleReply}
          onReact={handleReactComment}
          onDelete={handleDeleteComment}
        />
      </div>
    </section>
  );
}

function groupReactions(reactions: Reaction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reactions) out[r.emoji] = (out[r.emoji] ?? 0) + 1;
  return out;
}

interface CommentsSectionProps {
  comments: Comment[];
  reactions: Reaction[];
  myUserId: string | undefined;
  pending: boolean;
  replyTarget: string | null;
  replyBody: string;
  onReplyOpen: (parentId: string) => void;
  onReplyClose: () => void;
  onReplyChange: (value: string) => void;
  onReplySubmit: (parentId: string) => Promise<void>;
  onReact: (commentId: string, emoji: string) => void;
  onDelete: (commentId: string) => void;
}

function CommentsSection(props: CommentsSectionProps) {
  const { comments } = props;

  if (comments.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-text-muted">
          Aún no hay respuestas. Aportá vos la primera.
        </CardContent>
      </Card>
    );
  }

  // Agrupamos: root comments + replies indexadas por parentCommentId.
  const rootComments = comments.filter((c) => c.parentCommentId === null);
  const repliesByParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parentCommentId) {
      const arr = repliesByParent.get(c.parentCommentId) ?? [];
      arr.push(c);
      repliesByParent.set(c.parentCommentId, arr);
    }
  }

  return (
    <div className="space-y-3">
      {rootComments.map((c) => {
        const replies = repliesByParent.get(c.id) ?? [];
        return (
          <CommentThread
            key={c.id}
            comment={c}
            replies={replies}
            reactions={props.reactions}
            myUserId={props.myUserId}
            pending={props.pending}
            isReplyOpen={props.replyTarget === c.id}
            replyBody={props.replyBody}
            onReplyOpen={() => props.onReplyOpen(c.id)}
            onReplyClose={props.onReplyClose}
            onReplyChange={props.onReplyChange}
            onReplySubmit={() => props.onReplySubmit(c.id)}
            onReact={props.onReact}
            onDelete={props.onDelete}
          />
        );
      })}
    </div>
  );
}

function CommentThread({
  comment,
  replies,
  isReplyOpen,
  replyBody,
  onReplyOpen,
  onReplyClose,
  onReplyChange,
  onReplySubmit,
  reactions,
  myUserId,
  pending,
  onReact,
  onDelete,
}: {
  comment: Comment;
  replies: Comment[];
  isReplyOpen: boolean;
  replyBody: string;
  onReplyOpen: () => void;
  onReplyClose: () => void;
  onReplyChange: (value: string) => void;
  onReplySubmit: () => Promise<void>;
  reactions: Reaction[];
  myUserId: string | undefined;
  pending: boolean;
  onReact: (commentId: string, emoji: string) => void;
  onDelete: (commentId: string) => void;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <CommentBody
          comment={comment}
          reactions={reactions}
          myUserId={myUserId}
          pending={pending}
          onReact={onReact}
          onDelete={onDelete}
          onReply={onReplyOpen}
          isReply={false}
        />

        {isReplyOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onReplySubmit();
            }}
            className="mt-3 ml-12 space-y-2 border-l-2 border-brand-200 pl-4"
          >
            <Textarea
              value={replyBody}
              onChange={(e) => onReplyChange(e.target.value)}
              placeholder={`Responder a ${comment.authorDisplayName ?? 'este comentario'}…`}
              rows={2}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending || !replyBody.trim()}>
                Publicar respuesta
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onReplyClose}>
                Cancelar
              </Button>
            </div>
          </form>
        ) : null}

        {replies.length > 0 ? (
          <div className="mt-4 space-y-3 border-l-2 border-border-soft pl-4">
            {replies.map((r) => (
              <CommentBody
                key={r.id}
                comment={r}
                reactions={reactions}
                myUserId={myUserId}
                pending={pending}
                onReact={onReact}
                onDelete={onDelete}
                isReply={true}
              />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CommentBody({
  comment,
  reactions,
  myUserId,
  pending,
  onReact,
  onDelete,
  onReply,
  isReply,
}: {
  comment: Comment;
  reactions: Reaction[];
  myUserId: string | undefined;
  pending: boolean;
  onReact: (commentId: string, emoji: string) => void;
  onDelete: (commentId: string) => void;
  onReply?: () => void;
  isReply: boolean;
}) {
  const grouped = groupReactions(reactions.filter((r) => r.commentId === comment.id));
  const mine = new Set(
    reactions
      .filter((r) => r.commentId === comment.id && r.authorId === myUserId)
      .map((r) => r.emoji),
  );
  const isAuthor = comment.authorId === myUserId;
  const initials = (comment.authorDisplayName ?? 'A')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="flex gap-3">
      <div
        aria-hidden="true"
        className={cn(
          'grid shrink-0 place-items-center rounded-full font-display font-bold text-white',
          isReply ? 'h-7 w-7 text-[10px]' : 'h-9 w-9 text-xs',
        )}
        style={{
          background: 'linear-gradient(135deg, #1E5AA8 0%, #18B5A8 100%)',
        }}
      >
        {initials || 'A'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text">
            {comment.authorDisplayName ?? 'Anónimo'}
          </span>
          <span className="text-xs text-text-subtle">{relTime(comment.createdAt)}</span>
          {isReply ? (
            <span className="text-[10px] uppercase tracking-wider text-text-subtle">
              · respuesta
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text">
          {comment.body}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {EMOJIS.map((e) => {
            const m = mine.has(e);
            const count = grouped[e] ?? 0;
            return (
              <button
                key={e}
                type="button"
                onClick={() => onReact(comment.id, e)}
                disabled={pending}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
                  m
                    ? 'border-[rgba(46,125,206,0.32)] bg-[var(--didacta-info-bg)] text-[var(--didacta-info-fg)]'
                    : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text',
                )}
              >
                <span>{e}</span>
                {count > 0 ? <span className="tabular-nums">{count}</span> : null}
              </button>
            );
          })}
          {/* "Responder" solo en root comments (1 nivel max). */}
          {!isReply && onReply ? (
            <button
              type="button"
              onClick={onReply}
              disabled={pending}
              className="text-xs font-semibold text-brand-600 hover:underline"
            >
              Responder
            </button>
          ) : null}
          {isAuthor ? (
            <button
              type="button"
              onClick={() => onDelete(comment.id)}
              disabled={pending}
              className="ml-auto text-xs text-danger-700 hover:underline"
            >
              Eliminar
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `hace ${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
}
