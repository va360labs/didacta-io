'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { CommunityTagChip } from '@/components/community-tag-chip';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { PostReactions } from '@/components/post-reactions';
import { parseBodyAttachments, type CommunityTag, type Post } from '@/modules/community';
import { AuthorNameLink, CommunityAvatar } from '@/components/community-avatar';
import { ClaseEmbedCard } from '@/components/clase-embed-card';
import { RichBody } from '@/components/rich-body';
import { parseClaseEmbed } from '@/lib/clase-embed';
import { formatDate } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';

export const TAG_COLORS = ['#1E5AA8', '#18B5A8', '#FF6F61', '#2E7DCE', '#0D1B2A'];

/** Máximo de miniaturas de adjuntos que mostramos en la tarjeta del feed. */
const MAX_FEED_THUMBS = 6;

type AttachmentTile =
  | { kind: 'image'; url: string; name: string }
  | { kind: 'file'; name: string }
  | { kind: 'overflow'; count: number };

/**
 * Tiempo relativo corto («ahora», «hace 5m»…); a partir de una semana, fecha.
 *
 * `t` es el `useTranslations('comunidadComponentes')` del componente que la
 * llama. Va OPCIONAL solo por compatibilidad: `modules/messaging` todavía la
 * importa y no ha pasado por su unidad de i18n, así que sin `t` devuelve el
 * español cableado de siempre (nunca una key en pantalla). Cuando messaging
 * migre, `t` pasa a obligatorio y esa rama desaparece.
 */
export function relTime(iso: string, t?: TranslatorLike): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff >= 86400 * 7) return formatDate(iso, { day: '2-digit', month: 'short' });
  const minutes = Math.floor(diff / 60);
  const hours = Math.floor(diff / 3600);
  const days = Math.floor(diff / 86400);
  if (!t) {
    if (diff < 60) return 'ahora';
    if (diff < 3600) return `hace ${minutes}m`;
    if (diff < 86400) return `hace ${hours}h`;
    return `hace ${days}d`;
  }
  if (diff < 60) return t('relTimeNow');
  if (diff < 3600) return t('relTimeMinutes', { minutes });
  if (diff < 86400) return t('relTimeHours', { hours });
  return t('relTimeDays', { days });
}

export function ThreadCard({
  post,
  viewerUserId,
  tagsByName,
  authorAvatarUrl,
  onOpen,
  onTagClick,
  onReactionToggle,
}: {
  post: Post;
  viewerUserId: string | null;
  tagsByName: ReadonlyMap<string, CommunityTag>;
  /** Avatar del autor resuelto por la página (por authorId). Null = iniciales. */
  authorAvatarUrl?: string | null;
  onOpen: () => void;
  onTagClick: (tag: string) => void;
  onReactionToggle: (emoji: string) => void;
}) {
  const t = useTranslations('comunidadComponentes');
  // El body trae los adjuntos serializados en un comentario HTML al final.
  // En el feed mostramos solo el texto + miniaturas de los adjuntos.
  const { cleanBody: bodyWithoutAttachments, images, files } = parseBodyAttachments(post.body);
  // Si el post anuncia una clase en directo, se pinta su tarjeta rica (con
  // inscripción en línea) en vez del enlace pelado.
  const { cleanBody, sessionId: claseId } = parseClaseEmbed(bodyWithoutAttachments);
  const allAttachments: AttachmentTile[] = [
    ...images.map((img) => ({ kind: 'image' as const, url: img.url, name: img.name })),
    ...files.map((f) => ({ kind: 'file' as const, name: f.name })),
  ];
  const attachmentTiles: AttachmentTile[] =
    allAttachments.length > MAX_FEED_THUMBS
      ? [
          ...allAttachments.slice(0, MAX_FEED_THUMBS - 1),
          { kind: 'overflow', count: allAttachments.length - (MAX_FEED_THUMBS - 1) },
        ]
      : allAttachments;

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      className="block cursor-pointer rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <Card interactive className="transition-shadow">
        <CardContent className="p-5">
          <div className="flex gap-3.5">
            <CommunityAvatar
              userId={post.authorId}
              name={post.authorDisplayName}
              avatarUrl={authorAvatarUrl}
              size={44}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {post.pinnedAt ? (
                  <Badge variant="warning" dot>
                    {t('pinnedBadge')}
                  </Badge>
                ) : null}
                <AuthorNameLink
                  userId={post.authorId}
                  name={post.authorDisplayName}
                  className="text-sm font-semibold text-text"
                />
                {post.tags.slice(0, 2).map((tag) => (
                  <CommunityTagChip
                    key={tag}
                    name={tag}
                    tag={tagsByName.get(tag)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTagClick(tag);
                    }}
                  />
                ))}
                <span className="text-xs text-text-subtle">{relTime(post.createdAt, t)}</span>
              </div>
              <h3
                className="font-display text-lg font-semibold wrap-break-word text-text"
                style={{ letterSpacing: '-0.01em' }}
              >
                {post.title}
              </h3>
              {cleanBody ? (
                <div className="line-clamp-4 wrap-break-word text-sm leading-relaxed text-text-muted">
                  <RichBody body={cleanBody} />
                </div>
              ) : null}
              {cleanBody.length > 240 ? (
                <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700">
                  {t('readMore')}
                </span>
              ) : null}
              {claseId ? <ClaseEmbedCard sessionId={claseId} /> : null}
              {attachmentTiles.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {attachmentTiles.map((tile, i) =>
                    tile.kind === 'image' ? (
                      <img
                        key={i}
                        src={tile.url}
                        alt={tile.name}
                        title={tile.name}
                        loading="lazy"
                        className="h-20 w-20 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] object-cover"
                      />
                    ) : tile.kind === 'file' ? (
                      <div
                        key={i}
                        title={tile.name}
                        className="grid h-20 w-20 place-items-center rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] text-text-muted"
                      >
                        <Icon name="file" size={28} />
                      </div>
                    ) : (
                      <div
                        key={i}
                        className="grid h-20 w-20 place-items-center rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] text-sm font-medium text-text-muted"
                      >
                        +{tile.count}
                      </div>
                    ),
                  )}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                  <Icon name="message" size={14} />
                  {post._count && post._count.comments > 0
                    ? t('commentCount', { count: post._count.comments })
                    : t('viewConversation')}
                </span>
                <PostReactions
                  reactions={post.reactions}
                  viewerUserId={viewerUserId}
                  onToggle={onReactionToggle}
                  variant="compact"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
