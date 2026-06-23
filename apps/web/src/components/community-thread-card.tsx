'use client';

import { CommunityTagChip } from '@/components/community-tag-chip';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { PostReactions } from '@/components/post-reactions';
import type { CommunityTag, Post } from '@/modules/community';

export const TAG_COLORS = ['#1E5AA8', '#18B5A8', '#FF6F61', '#2E7DCE', '#0D1B2A'];

export function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `hace ${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

export function ThreadCard({
  post,
  viewerUserId,
  tagsByName,
  onOpen,
  onTagClick,
  onReactionToggle,
}: {
  post: Post;
  viewerUserId: string | null;
  tagsByName: ReadonlyMap<string, CommunityTag>;
  onOpen: () => void;
  onTagClick: (tag: string) => void;
  onReactionToggle: (emoji: string) => void;
}) {
  const initials = (post.authorDisplayName ?? 'A')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

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
            <div
              aria-hidden="true"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full font-display text-sm font-bold text-white"
              style={{ background: 'linear-gradient(135deg, #1E5AA8 0%, #18B5A8 100%)' }}
            >
              {initials || 'A'}
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {post.pinnedAt ? (
                  <Badge variant="warning" dot>
                    Fijado
                  </Badge>
                ) : null}
                <span className="text-sm font-semibold text-text">
                  {post.authorDisplayName ?? 'Anónimo'}
                </span>
                {post.tags.slice(0, 2).map((t) => (
                  <CommunityTagChip
                    key={t}
                    name={t}
                    tag={tagsByName.get(t)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTagClick(t);
                    }}
                  />
                ))}
                <span className="text-xs text-text-subtle">{relTime(post.createdAt)}</span>
              </div>
              <h3
                className="font-display text-lg font-semibold text-text"
                style={{ letterSpacing: '-0.01em' }}
              >
                {post.title}
              </h3>
              <p className="line-clamp-4 text-sm leading-relaxed text-text-muted">{post.body}</p>
              {post.body.length > 240 ? (
                <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700">
                  Leer más →
                </span>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                  <Icon name="message" size={14} />
                  {post._count && post._count.comments > 0
                    ? `${post._count.comments} ${post._count.comments === 1 ? 'comentario' : 'comentarios'}`
                    : 'Ver conversación'}
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
