'use client';

import { useEffect, useMemo, useState } from 'react';
import { CommunityGalleryModal } from '@/components/community-gallery-modal';
import { CommunityTagChip } from '@/components/community-tag-chip';
import { ThreadCard, TAG_COLORS } from '@/components/community-thread-card';
import { Icon } from '@/components/icon';
import { PostComposerModal } from '@/components/post-composer-modal';
import { PostDetailView } from '@/components/post-detail-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { cn } from '@/lib/utils';
import {
  communityApi,
  useCommunityTags,
  type CommunityTag,
  type Post,
  type PostSort,
} from '@/modules/community';

const SORT_LABELS: Record<PostSort, string> = {
  recent: 'Más recientes',
  oldest: 'Más antiguas',
  most_commented: 'Más comentadas',
};

export default function ComunidadPage() {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [activeTag, setActiveTag] = useState<string>('Todo');
  const [sort, setSort] = useState<PostSort>('recent');
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);

  async function reload(opts: { sort?: PostSort; tag?: string } = {}) {
    try {
      const tagFilter = opts.tag ?? activeTag;
      setPosts(
        await communityApi.listPosts({
          sort: opts.sort ?? sort,
          tag: tagFilter === 'Todo' ? undefined : tagFilter,
        }),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar la comunidad.');
    }
  }

  useEffect(() => {
    void reload({ sort, tag: activeTag });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, activeTag]);

  const allTags = useMemo(() => {
    const set = new Set<string>(['Todo']);
    if (posts) for (const p of posts) for (const t of p.tags) set.add(t);
    if (activeTag !== 'Todo') set.add(activeTag);
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
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos actualizar la reacción.');
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
        title="Comunidad · Galería"
      />

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="font-display text-2xl font-bold tracking-tight text-text"
            style={{ letterSpacing: '-0.02em' }}
          >
            Comunidad
          </h1>
          <p className="mt-1.5 text-text-muted">
            Conversaciones útiles entre formadores, alumnos y administradores.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setComposerOpen(true)}>
            <Icon name="plus" size={16} />
            Nueva conversación
          </Button>
          <Button variant="secondary" onClick={() => setGalleryOpen(true)}>
            <Icon name="image" size={16} />
            Galería
          </Button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        {/* Feed */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              {allTags.map((t) => {
                const isActive = activeTag === t;
                const curated = t === 'Todo' ? undefined : tagsByName.get(t);
                if (curated) {
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setActiveTag(t)}
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
                      <CommunityTagChip name={t} tag={curated} />
                    </button>
                  );
                }
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setActiveTag(t)}
                    className={cn(
                      'rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
                      isActive
                        ? 'bg-[var(--didacta-night)] text-white'
                        : 'bg-[var(--didacta-surface)] text-text-muted hover:text-text',
                    )}
                  >
                    {t}
                  </button>
                );
              })}
              <label className="ml-auto flex items-center gap-2 text-xs text-text-subtle">
                Ordenar:
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as PostSort)}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-text focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {(Object.keys(SORT_LABELS) as PostSort[]).map((k) => (
                    <option key={k} value={k}>
                      {SORT_LABELS[k]}
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
                {activeTag === 'Todo' ? (
                  'Aún no hay conversaciones. Empieza tú: haz click en "Nueva conversación".'
                ) : (
                  <>
                    <span>
                      Sin conversaciones con el tag <strong>{activeTag}</strong>.
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setActiveTag('Todo')}
                    >
                      Limpiar filtro
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
                onOpen={() => setSelectedPostId(p.id)}
                onTagClick={(t) => setActiveTag(t)}
                onReactionToggle={(emoji) => void handleReactPost(p.id, emoji)}
              />
            ))
          )}
        </div>

        {/* Sidebar derecha */}
        <aside className="flex flex-col gap-4">
          <Card>
            <CardContent className="p-5">
              <h4 className="font-display text-base font-semibold text-text">Tu actividad</h4>
              <div className="mt-3 divide-y divide-border-soft text-sm">
                <ActivityRow label="Publicaciones" value={posts?.length ?? 0} />
                <ActivityRow label="Respuestas útiles" value={0} tone="success" />
                <ActivityRow label="Reconocimientos" value={0} tone="info" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <h4 className="font-display text-base font-semibold text-text">Tags activos</h4>
              <div className="mt-3 space-y-2">
                {allTags
                  .filter((t) => t !== 'Todo')
                  .map((t, i) => {
                    const curated = tagsByName.get(t);
                    const swatchColor = curated?.color ?? TAG_COLORS[i % TAG_COLORS.length]!;
                    return (
                      <div
                        key={t}
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
                        <span className="flex-1 text-sm font-medium text-text">{t}</span>
                        <span className="text-xs text-text-subtle tabular-nums">
                          {posts?.filter((p) => p.tags.includes(t)).length ?? 0}
                        </span>
                      </div>
                    );
                  })}
                {allTags.length <= 1 ? (
                  <p className="text-xs text-text-subtle">
                    Aún no hay tags. Etiqueta tu próxima publicación para organizar la comunidad.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>

      <Dialog
        open={selectedPostId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPostId(null);
        }}
        ariaLabel="Detalle de la conversación"
        maxWidthClass="max-w-5xl"
        contentClassName="p-6 sm:p-8"
      >
        {selectedPostId ? (
          <PostDetailView
            postId={selectedPostId}
            onClose={() => setSelectedPostId(null)}
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
