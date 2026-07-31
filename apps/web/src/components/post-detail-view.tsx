'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useRef, useState } from 'react';
import { CommunityTagChip } from '@/components/community-tag-chip';
import { EmojiPicker } from '@/components/emoji-picker';
import { Icon } from '@/components/icon';
import { ImageLightbox } from '@/components/image-lightbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MentionTextarea } from '@/components/mention-textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { postShareUrl } from '@/lib/post-link';
import { cn } from '@/lib/utils';
import { AuthorNameLink, CommunityAvatar } from '@/components/community-avatar';
import { ClaseEmbedCard } from '@/components/clase-embed-card';
import { RichBody } from '@/components/rich-body';
import { parseClaseEmbed } from '@/lib/clase-embed';
import { PostComposerModal } from '@/components/post-composer-modal';
import { usePublicUsers } from '@/lib/public-users';
import {
  communityApi,
  parseBodyAttachments,
  useCommunityTags,
  type AttachmentFile,
  type AttachmentImage,
  type Comment,
  type PostDetail,
  type Reaction,
} from '@/modules/community';

const EMOJIS = ['👍', '❤️', '🎉', '🤔'];

interface PostDetailViewProps {
  postId: string;
  /**
   * Si viene (p. ej. desde una notificación `?comment=`), tras cargar el post
   * hacemos scroll a ese comentario y, si es un comentario raíz, abrimos su
   * composer de respuesta enfocado — "ir directamente a responder".
   */
  focusCommentId?: string;
  onClose?: () => void;
  onChanged?: () => void;
}

export function PostDetailView({
  postId,
  focusCommentId,
  onClose,
  onChanged,
}: PostDetailViewProps) {
  const [post, setPost] = useState<PostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [commentEmojiOpen, setCommentEmojiOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const commentBodyRef = useRef<HTMLTextAreaElement>(null);
  const myUserId = authStorage.getSession()?.user.id;
  const myRoles = authStorage.getSession()?.user.roles ?? [];
  const canModerate = myRoles.includes('super_admin') || myRoles.includes('tenant_admin');
  const tagsByName = useCommunityTags();
  // Avatar del autor del post (por authorId). Los comentarios resuelven el suyo
  // en CommentBody (reusa este cache).
  const postAuthor = usePublicUsers(post ? [post.authorId] : []);

  async function reload(opts: { silent?: boolean } = {}) {
    try {
      setPost(await communityApi.getPost(postId));
      setError(null);
      if (!opts.silent) onChanged?.();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar el post.');
    }
  }

  useEffect(() => {
    void reload({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  // Deep-link desde notificación: al cargar el post, enfoca el comentario y —si
  // es raíz— abre su composer de respuesta. Se aplica una sola vez.
  const appliedFocusRef = useRef(false);
  useEffect(() => {
    if (!post || !focusCommentId || appliedFocusRef.current) return;
    const target = post.comments.find((c) => c.id === focusCommentId);
    if (!target) return;
    appliedFocusRef.current = true;
    if (target.parentCommentId === null) {
      setReplyTarget(focusCommentId);
      setReplyBody('');
    }
    // Esperamos un tick a que monte el composer antes de hacer scroll.
    const t = setTimeout(() => {
      document
        .getElementById(`comment-${focusCommentId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    return () => clearTimeout(t);
  }, [post, focusCommentId]);

  function insertCommentEmoji(emoji: string) {
    const ta = commentBodyRef.current;
    if (!ta) {
      setCommentBody((b) => b + emoji);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = commentBody.slice(0, start) + emoji + commentBody.slice(end);
    setCommentBody(next);
    ta.focus();
    setTimeout(() => ta.setSelectionRange(start + emoji.length, start + emoji.length), 0);
  }

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

  async function handleTogglePin() {
    if (!post) return;
    const isPinned = post.pinnedAt !== null;
    setPending(true);
    try {
      if (isPinned) {
        await communityApi.unpinPost(post.id);
      } else {
        await communityApi.pinPost(post.id);
      }
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos cambiar el pin.');
    } finally {
      setPending(false);
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

  async function handleCopyLink() {
    if (!post) return;
    const url = postShareUrl(post.id);
    let copied = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Contextos sin Clipboard API (http plano, permisos): textarea + execCommand.
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      // Sin confirmación falsa: dejamos el enlace a la vista para copiarlo a mano.
      setError(`No pudimos copiar el enlace. Copialo manualmente: ${url}`);
      return;
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  async function handleDeletePost() {
    if (!post) return;
    if (!window.confirm('¿Eliminar este post? Solo el autor puede.')) return;
    setPending(true);
    try {
      await communityApi.deletePost(post.id);
      onChanged?.();
      onClose?.();
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
    return <div className="rounded-lg bg-danger-50 p-4 text-sm text-danger-700">{error}</div>;
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
  return (
    <div>
      {/* ── Post ── */}
      <div className="flex gap-3">
        <CommunityAvatar
          userId={post.authorId}
          name={post.authorDisplayName}
          avatarUrl={postAuthor.get(post.authorId)?.avatarUrl ?? null}
          size={40}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <AuthorNameLink
              userId={post.authorId}
              name={post.authorDisplayName}
              className="text-sm font-semibold text-[#0D1B2A]"
            />
            {post.tags.slice(0, 3).map((t) => (
              <CommunityTagChip key={t} name={t} tag={tagsByName.get(t)} />
            ))}
            <span className="text-xs text-[#94A3B8]">{relTime(post.createdAt)}</span>
            {post.editedAt ? (
              <span className="text-xs text-[#CBD5E1]" title="Editado">
                · editado
              </span>
            ) : null}
            {post.pinnedAt ? (
              <Badge variant="warning" dot>
                Fijado
              </Badge>
            ) : null}
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
        </div>
      </div>

      <h1
        className="font-display mt-4 text-2xl font-bold leading-tight text-[#0D1B2A]"
        style={{ letterSpacing: '-0.02em' }}
      >
        {post.title}
      </h1>
      {(() => {
        const { cleanBody: withoutAttachments, images, files } = parseBodyAttachments(post.body);
        // Un post que anuncia una clase en directo muestra su tarjeta con
        // inscripción en línea, igual que en el feed.
        const { cleanBody, sessionId: claseId } = parseClaseEmbed(withoutAttachments);
        return (
          <>
            {/* div, no p: RichBody emite bloques (títulos, listas, párrafos). */}
            <div className="mt-3 text-[15px] leading-relaxed text-[#374151]">
              <RichBody body={cleanBody} />
            </div>
            {claseId ? <ClaseEmbedCard sessionId={claseId} /> : null}
            {images.length > 0 && <ImageGallery images={images} />}
            {files.length > 0 && <FileList files={files} />}
          </>
        );
      })()}

      {/* Reactions + mod actions */}
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
                  ? 'border-[rgba(46,125,206,0.32)] bg-(--didacta-info-bg) text-(--didacta-info-fg)'
                  : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B] hover:border-[#CBD5E1] hover:text-[#374151]',
              )}
            >
              <span>{e}</span>
              {count > 0 ? <span className="tabular-nums">{count}</span> : null}
            </button>
          );
        })}
        {/* Enlace directo compartible del post — visible para todos. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void handleCopyLink()}
          title="Copiar enlace directo"
          aria-label="Copiar enlace directo"
          className="ml-auto text-[#64748B]"
        >
          <Icon name={linkCopied ? 'check' : 'link'} size={14} />
          {linkCopied ? 'Enlace copiado' : 'Copiar enlace'}
        </Button>
        {isAuthor || canModerate ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            disabled={pending}
            className="text-[#64748B]"
          >
            Editar
          </Button>
        ) : null}
        {canModerate ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleTogglePin}
            disabled={pending}
            className="text-[#64748B]"
          >
            {post.pinnedAt ? 'Desfijar' : 'Fijar'}
          </Button>
        ) : null}
        {canModerate ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleModeratePost}
            disabled={pending}
            className="text-[#64748B]"
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
            className="text-danger-700 hover:bg-danger-50"
          >
            Eliminar post
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 rounded-md bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</p>
      ) : null}

      {/* ── Separator ── */}
      <div className="mt-5 h-px bg-[#F1F5F9]" />

      {/* ── Comment form ── */}
      <div className="mt-4">
        <form onSubmit={handleAddComment} className="space-y-3">
          <MentionTextarea
            ref={commentBodyRef}
            rows={3}
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder="Aporta tu respuesta… puedes mencionar con @usuario"
            required
            className="border-[#E2E8F0] bg-[#F8FAFC] text-[15px] focus:border-[#1E5AA8] focus:bg-white transition-colors"
          />
          <div className="flex items-center gap-2">
            {/* Emoji picker trigger */}
            <div className="relative">
              <button
                type="button"
                title="Emoji"
                onClick={() => setCommentEmojiOpen((v) => !v)}
                aria-expanded={commentEmojiOpen}
                aria-haspopup="dialog"
                className="grid h-8 w-8 place-items-center rounded-lg text-[#94A3B8] hover:bg-[#F1F5F9] hover:text-[#64748B] transition-colors"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
                </svg>
              </button>
              {commentEmojiOpen && (
                <EmojiPicker
                  onSelect={insertCommentEmoji}
                  onClose={() => setCommentEmojiOpen(false)}
                />
              )}
            </div>
            <div className="ml-auto">
              <Button type="submit" disabled={pending || !commentBody.trim()}>
                <Icon name="message" size={16} />
                {pending ? 'Enviando…' : 'Responder'}
              </Button>
            </div>
          </div>
        </form>
      </div>

      {/* ── Comments ── */}
      <div className="mt-4 h-px bg-[#F1F5F9]" />

      <div className="mt-4 flex items-center justify-between">
        <h2
          className="font-display text-base font-semibold text-[#0D1B2A]"
          style={{ letterSpacing: '-0.01em' }}
        >
          {post.comments.length} respuesta{post.comments.length === 1 ? '' : 's'}
        </h2>
      </div>

      <CommentsSection
        comments={post.comments}
        reactions={post.reactions}
        myUserId={myUserId}
        canModerate={canModerate}
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
        onModerate={handleModerateComment}
      />

      {editing ? (
        <PostComposerModal
          open={editing}
          editPost={post}
          spaceSlug={post.tags[0] ?? ''}
          onClose={() => setEditing(false)}
          onSuccess={() => {
            setEditing(false);
            void reload();
            onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Image gallery + lightbox ──────────────────────────────────────────────────

function ImageGallery({ images }: { images: AttachmentImage[] }) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        {images.map((img, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setLightboxIdx(i)}
            title={img.name}
            className="relative h-20 w-20 overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] focus:outline-none focus:ring-2 focus:ring-[#1E5AA8]"
          >
            <img
              src={img.url}
              alt={img.name}
              className="h-full w-full object-cover transition-transform hover:scale-105 duration-200"
            />
          </button>
        ))}
      </div>

      {lightboxIdx !== null && (
        <ImageLightbox
          images={images}
          initialIdx={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </>
  );
}

// ── File list ─────────────────────────────────────────────────────────────────

function FileList({ files }: { files: AttachmentFile[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {files.map((f, i) => (
        <a
          key={i}
          href={f.url}
          target="_blank"
          rel="noopener noreferrer"
          title={f.name}
          className="grid h-20 w-20 place-items-center rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B] transition-colors hover:bg-[#F1F5F9]"
        >
          <Icon name="file" size={28} />
        </a>
      ))}
    </div>
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
  canModerate: boolean;
  pending: boolean;
  replyTarget: string | null;
  replyBody: string;
  onReplyOpen: (parentId: string) => void;
  onReplyClose: () => void;
  onReplyChange: (value: string) => void;
  onReplySubmit: (parentId: string) => Promise<void>;
  onReact: (commentId: string, emoji: string) => void;
  onDelete: (commentId: string) => void;
  onModerate: (commentId: string, isHidden: boolean) => void;
}

function CommentsSection(props: CommentsSectionProps) {
  const { comments } = props;

  if (comments.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[#94A3B8]">
        Aún no hay respuestas. Aporta tú la primera.
      </div>
    );
  }

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
    <div className="mt-2 divide-y divide-[#F1F5F9]">
      {rootComments.map((c) => {
        const replies = repliesByParent.get(c.id) ?? [];
        return (
          <CommentThread
            key={c.id}
            comment={c}
            replies={replies}
            reactions={props.reactions}
            myUserId={props.myUserId}
            canModerate={props.canModerate}
            pending={props.pending}
            isReplyOpen={props.replyTarget === c.id}
            replyBody={props.replyBody}
            onReplyOpen={() => props.onReplyOpen(c.id)}
            onReplyClose={props.onReplyClose}
            onReplyChange={props.onReplyChange}
            onReplySubmit={() => props.onReplySubmit(c.id)}
            onReact={props.onReact}
            onDelete={props.onDelete}
            onModerate={props.onModerate}
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
  canModerate,
  pending,
  onReact,
  onDelete,
  onModerate,
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
  canModerate: boolean;
  pending: boolean;
  onReact: (commentId: string, emoji: string) => void;
  onDelete: (commentId: string) => void;
  onModerate: (commentId: string, isHidden: boolean) => void;
}) {
  return (
    <div className="py-4" id={`comment-${comment.id}`}>
      <CommentBody
        comment={comment}
        reactions={reactions}
        myUserId={myUserId}
        canModerate={canModerate}
        pending={pending}
        onReact={onReact}
        onDelete={onDelete}
        onModerate={onModerate}
        onReply={onReplyOpen}
        isReply={false}
      />

      {isReplyOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onReplySubmit();
          }}
          className="mt-3 ml-10 space-y-2 border-l-2 border-[#E2E8F0] pl-4"
        >
          <MentionTextarea
            value={replyBody}
            onChange={(e) => onReplyChange(e.target.value)}
            placeholder={`Responder a ${comment.authorDisplayName ?? 'este comentario'}… (@usuario para mencionar)`}
            rows={2}
            autoFocus
            className="border-[#E2E8F0] bg-[#F8FAFC] text-sm"
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
        <div className="mt-3 space-y-3 border-l-2 border-[#F1F5F9] pl-4 ml-10">
          {replies.map((r) => (
            <CommentBody
              key={r.id}
              comment={r}
              reactions={reactions}
              myUserId={myUserId}
              canModerate={canModerate}
              pending={pending}
              onReact={onReact}
              onDelete={onDelete}
              onModerate={onModerate}
              isReply={true}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommentBody({
  comment,
  reactions,
  myUserId,
  canModerate,
  pending,
  onReact,
  onDelete,
  onModerate,
  onReply,
  isReply,
}: {
  comment: Comment;
  reactions: Reaction[];
  myUserId: string | undefined;
  canModerate: boolean;
  pending: boolean;
  onReact: (commentId: string, emoji: string) => void;
  onDelete: (commentId: string) => void;
  onModerate: (commentId: string, isHidden: boolean) => void;
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
  const commentAuthor = usePublicUsers([comment.authorId]);

  return (
    <div className="flex gap-3">
      <CommunityAvatar
        userId={comment.authorId}
        name={comment.authorDisplayName}
        avatarUrl={commentAuthor.get(comment.authorId)?.avatarUrl ?? null}
        size={isReply ? 28 : 36}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <AuthorNameLink
            userId={comment.authorId}
            name={comment.authorDisplayName}
            className="text-sm font-semibold text-[#0D1B2A]"
          />
          <span className="text-xs text-[#94A3B8]">{relTime(comment.createdAt)}</span>
          {isReply ? (
            <span className="text-[10px] uppercase tracking-wider text-[#CBD5E1]">· respuesta</span>
          ) : null}
          {comment.hiddenAt ? (
            <Badge variant="warning" dot>
              Oculto
            </Badge>
          ) : null}
        </div>
        <div className="mt-1.5 text-sm leading-relaxed text-[#374151]">
          <RichBody body={comment.body} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
                    ? 'border-[rgba(46,125,206,0.32)] bg-(--didacta-info-bg) text-(--didacta-info-fg)'
                    : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#94A3B8] hover:border-[#CBD5E1] hover:text-[#64748B]',
                )}
              >
                <span>{e}</span>
                {count > 0 ? <span className="tabular-nums">{count}</span> : null}
              </button>
            );
          })}
          {!isReply && onReply ? (
            <button
              type="button"
              onClick={onReply}
              disabled={pending}
              className="text-xs font-semibold text-[#1E5AA8] hover:underline"
            >
              Responder
            </button>
          ) : null}
          {canModerate ? (
            <button
              type="button"
              onClick={() => onModerate(comment.id, comment.hiddenAt !== null)}
              disabled={pending}
              className="text-xs font-semibold text-[#94A3B8] hover:underline"
            >
              {comment.hiddenAt ? 'Restaurar' : 'Ocultar'}
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
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}
