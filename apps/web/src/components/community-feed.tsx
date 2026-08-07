'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { CommunityGalleryModal } from '@/components/community-gallery-modal';
import { CommunityTagChip } from '@/components/community-tag-chip';
import { ThreadCard, TAG_COLORS } from '@/components/community-thread-card';
import { CommunityUpcomingCard } from '@/components/community-upcoming-card';
import { usePublicUsers } from '@/lib/public-users';
import { Icon } from '@/components/icon';
import { PostComposerModal } from '@/components/post-composer-modal';
import { PostDetailView } from '@/components/post-detail-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { usePostModalRoute } from '@/lib/use-post-modal-route';
import { cn } from '@/lib/utils';
import {
  communityApi,
  useCommunityTags,
  type CommunityTag,
  type Post,
  type PostSort,
} from '@/modules/community';

const SORT_OPTIONS: readonly PostSort[] = ['recent', 'oldest', 'most_commented'];

/**
 * Valor centinela del filtro «todos los tags». Es INTERNO (viaja al estado y
 * decide si se manda `tag` a la API); lo que se pinta es `t('filterAll')`.
 */
const ALL_TAGS = 'Todo';

/**
 * Feed de la comunidad + modal de detalle con URL canónica por post.
 *
 * Lo renderizan `/comunidad` (feed sin post abierto) y `/comunidad/[id]`
 * (deep-link compartible: mismo feed con el post abierto en modal). Abrir un
 * post desde el feed actualiza la URL a `/comunidad/<id>` sin desmontar el
 * feed; cerrar el modal la restaura.
 */
export function CommunityFeed({
  initialPostId,
  focusCommentId,
}: {
  initialPostId?: string;
  focusCommentId?: string;
}) {
  const t = useTranslations('comunidadComponentes');
  const tErrors = useTranslations('errors');
  const [posts, setPosts] = useState<Post[] | null>(null);
  // Avatares de los autores (resueltos por authorId; no vienen en el post).
  const authorAvatars = usePublicUsers((posts ?? []).map((p) => p.authorId));
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [activeTag, setActiveTag] = useState<string>(ALL_TAGS);
  const [sort, setSort] = useState<PostSort>('recent');
  // El post abierto se deriva de la URL (usePathname); en el deep-link
  // /comunidad/[id] la propia URL ya abre el modal, sin estado extra.
  const { selectedPostId, openPost, closePost } = usePostModalRoute({
    fallbackPath: '/comunidad',
  });

  async function reload(opts: { sort?: PostSort; tag?: string } = {}) {
    try {
      const tagFilter = opts.tag ?? activeTag;
      setPosts(
        await communityApi.listPosts({
          sort: opts.sort ?? sort,
          tag: tagFilter === ALL_TAGS ? undefined : tagFilter,
        }),
      );
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload({ sort, tag: activeTag });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, activeTag]);

  const allTags = useMemo(() => {
    const set = new Set<string>([ALL_TAGS]);
    if (posts) for (const p of posts) for (const tag of p.tags) set.add(tag);
    if (activeTag !== ALL_TAGS) set.add(activeTag);
    return Array.from(set).slice(0, 8);
  }, [posts, activeTag]);

  const filtered = posts ?? [];

  const viewerUserId = useMemo(() => authStorage.getSession()?.user.id ?? null, []);
  const tagsByName = useCommunityTags();

  async function handleReactPost(postId: string, emoji: string) {
    const post = posts?.find((p) => p.id === postId);
    if (!post) return;
    const mine = post.reactions?.find((r) => r.authorId === viewerUserId && r.emoji === emoji);
    try {
      if (mine) {
        await communityApi.removeReaction(mine.id);
      } else {
        await communityApi.addReactionToPost(postId, emoji);
      }
      await reload({ sort, tag: activeTag });
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    }
  }

  return (
    <section className="space-y-6">
      <PostComposerModal
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        spaceSlug="general"
        onSuccess={() => void reload({ sort, tag: activeTag })}
      />

      <CommunityGalleryModal
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        title={t('galleryTitle')}
      />

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="font-display text-2xl font-bold tracking-tight text-text"
            style={{ letterSpacing: '-0.02em' }}
          >
            {t('feedTitle')}
          </h1>
          <p className="mt-1.5 text-text-muted">{t('feedSubtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setComposerOpen(true)}>
            <Icon name="plus" size={16} />
            {t('newConversation')}
          </Button>
          <Button variant="secondary" onClick={() => setGalleryOpen(true)}>
            <Icon name="image" size={16} />
            {t('gallery')}
          </Button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        {/* Feed */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              {allTags.map((tag) => {
                const isActive = activeTag === tag;
                const curated = tag === ALL_TAGS ? undefined : tagsByName.get(tag);
                if (curated) {
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setActiveTag(tag)}
                      aria-pressed={isActive}
                      className={cn(
                        'rounded-full transition-shadow',
                        isActive && 'ring-2 ring-offset-2 ring-offset-bg',
                      )}
                      style={
                        isActive
                          ? ({ '--tw-ring-color': curated.color } as React.CSSProperties)
                          : undefined
                      }
                    >
                      <CommunityTagChip name={tag} tag={curated} />
                    </button>
                  );
                }
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setActiveTag(tag)}
                    className={cn(
                      'rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
                      isActive
                        ? 'bg-[var(--didacta-night)] text-white'
                        : 'bg-[var(--didacta-surface)] text-text-muted hover:text-text',
                    )}
                  >
                    {tag === ALL_TAGS ? t('filterAll') : tag}
                  </button>
                );
              })}
              <label className="ml-auto flex items-center gap-2 text-xs text-text-subtle">
                {t('sortLabel')}
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as PostSort)}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-text focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {SORT_OPTIONS.map((k) => (
                    <option key={k} value={k}>
                      {t(`sort.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
            </CardContent>
          </Card>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          {posts === null ? (
            <>
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-32 w-full" />
              ))}
            </>
          ) : filtered.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 p-12 text-center text-sm text-text-muted">
                {activeTag === ALL_TAGS ? (
                  t('emptyFeed')
                ) : (
                  <>
                    <span>
                      {t.rich('emptyTagFiltered', {
                        tag: activeTag,
                        strong: (chunks) => <strong>{chunks}</strong>,
                      })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setActiveTag(ALL_TAGS)}
                    >
                      {t('clearFilter')}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            filtered.map((p) => (
              <ThreadCard
                key={p.id}
                post={p}
                viewerUserId={viewerUserId}
                tagsByName={tagsByName}
                authorAvatarUrl={authorAvatars.get(p.authorId)?.avatarUrl ?? null}
                onOpen={() => openPost(p.id)}
                onTagClick={(tag) => setActiveTag(tag)}
                onReactionToggle={(emoji) => void handleReactPost(p.id, emoji)}
              />
            ))
          )}
        </div>

        {/* Sidebar derecha */}
        <aside className="flex min-w-0 flex-col gap-4">
          {/* Lo primero: al abrir la comunidad se ve qué hay por delante sin
              tener que ir hasta /calendario. */}
          <CommunityUpcomingCard />

          <Card>
            <CardContent className="p-5">
              <h4 className="font-display text-base font-semibold text-text">{t('activity')}</h4>
              <div className="mt-3 divide-y divide-border-soft text-sm">
                {/* Solo datos reales: nº de publicaciones del feed actual. Las
                    métricas "Respuestas útiles"/"Reconocimientos" se quitaron por
                    no tener endpoint que las respalde (regla: cero datos de cartón). */}
                <ActivityRow label={t('postsInFeed')} value={posts?.length ?? 0} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <h4 className="font-display text-base font-semibold text-text">{t('activeTags')}</h4>
              <div className="mt-3 space-y-2">
                {allTags
                  .filter((tag) => tag !== ALL_TAGS)
                  .map((tag, i) => {
                    const curated = tagsByName.get(tag);
                    const swatchColor = curated?.color ?? TAG_COLORS[i % TAG_COLORS.length]!;
                    return (
                      <div
                        key={tag}
                        className={cn(
                          'flex items-center gap-2.5 py-1.5',
                          i > 0 ? 'border-t border-border-soft pt-3' : '',
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className="block h-7 w-7 rounded-lg"
                          style={{ background: swatchColor, opacity: 0.18 }}
                        />
                        <span className="min-w-0 flex-1 wrap-break-word text-sm font-medium text-text">
                          {tag}
                        </span>
                        <span className="text-xs text-text-subtle tabular-nums">
                          {posts?.filter((p) => p.tags.includes(tag)).length ?? 0}
                        </span>
                      </div>
                    );
                  })}
                {allTags.length <= 1 ? (
                  <p className="text-xs text-text-subtle">{t('noTags')}</p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>

      <Dialog
        open={selectedPostId !== null}
        onOpenChange={(open) => {
          if (!open) closePost();
        }}
        ariaLabel={t('conversationDetailAria')}
        maxWidthClass="max-w-5xl"
        contentClassName="p-6 sm:p-8"
      >
        {selectedPostId ? (
          <PostDetailView
            postId={selectedPostId}
            focusCommentId={selectedPostId === initialPostId ? focusCommentId : undefined}
            onClose={closePost}
            onChanged={() => void reload({ sort, tag: activeTag })}
          />
        ) : null}
      </Dialog>
    </section>
  );
}

function ActivityRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'info';
}) {
  const color =
    tone === 'success'
      ? 'text-[var(--didacta-success-fg)]'
      : tone === 'info'
        ? 'text-[var(--didacta-info-fg)]'
        : 'text-text';
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-text-muted">{label}</span>
      <strong className={cn('tabular-nums font-semibold', color)}>{value}</strong>
    </div>
  );
}
