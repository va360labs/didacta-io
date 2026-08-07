'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { use, useEffect, useMemo, useState } from 'react';
import { CommunityGalleryModal } from '@/components/community-gallery-modal';
import { ThreadCard } from '@/components/community-thread-card';
import { usePublicUsers } from '@/lib/public-users';
import { Icon } from '@/components/icon';
import { PostComposerModal } from '@/components/post-composer-modal';
import { PostDetailView } from '@/components/post-detail-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { usePostModalRoute } from '@/lib/use-post-modal-route';
import { SpaceIcon } from '@/components/space-icon';
import {
  communityApi,
  useCommunityTags,
  useCommunitySpaces,
  type Post,
  type PostSort,
} from '@/modules/community';

const SORT_LABELS: Record<PostSort, string> = {
  recent: 'Más recientes',
  oldest: 'Más antiguas',
  most_commented: 'Más comentadas',
};

export default function SpacePage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = use(params);
  const spaces = useCommunitySpaces();
  const meta = spaces.find((s) => s.slug === space) ?? spaces[0];

  const [posts, setPosts] = useState<Post[] | null>(null);
  const authorAvatars = usePublicUsers((posts ?? []).map((p) => p.authorId));
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [sort, setSort] = useState<PostSort>('recent');
  // Abrir un post muestra su URL canónica compartible (/comunidad/<id>) sin
  // desmontar el feed del espacio; al cerrar se restaura /espacios/<space>.
  const { selectedPostId, openPost, closePost } = usePostModalRoute({
    fallbackPath: `/espacios/${space}`,
  });

  const viewerUserId = useMemo(() => authStorage.getSession()?.user.id ?? null, []);
  const tagsByName = useCommunityTags();
  const otherSpaces = spaces.filter((s) => s.slug !== space);

  async function reload(opts: { sort?: PostSort } = {}) {
    try {
      const data = await communityApi.listPosts({ tag: space, sort: opts.sort ?? sort });
      setPosts(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudieron cargar las publicaciones.');
    }
  }

  useEffect(() => {
    void reload({ sort });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, sort]);

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
      await reload({ sort });
    } catch {
      // Best-effort: la reacción fallida no amerita romper el feed.
    }
  }

  return (
    <section className="space-y-6">
      <PostComposerModal
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        spaceSlug={space}
        onSuccess={() => void reload({ sort })}
      />

      <CommunityGalleryModal
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        tag={space}
        title={`${meta?.title ?? space} · Galería`}
      />

      {/* Cabecera */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xl"
            style={{
              backgroundColor: `color-mix(in srgb, ${meta?.color ?? 'var(--didacta-trust)'} 15%, transparent)`,
            }}
          >
            <SpaceIcon icon={meta?.icon ?? 'hash'} color={meta?.color} size={20} />
          </div>
          <div>
            <h1
              className="font-display text-2xl font-bold tracking-tight text-text"
              style={{ letterSpacing: '-0.02em' }}
            >
              {meta?.title ?? space}
            </h1>
            <p className="mt-1 text-text-muted">{meta?.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setComposerOpen(true)}>
            <Icon name="plus" size={16} />
            Nueva publicación
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
            <CardContent className="flex items-center justify-end p-3">
              <label className="flex items-center gap-2 text-xs text-text-subtle">
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
          ) : posts.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 p-12 text-center text-sm text-text-muted">
                Aún no hay publicaciones en #{meta?.title ?? space}. ¡Sé el primero!
              </CardContent>
            </Card>
          ) : (
            posts.map((p) => (
              <ThreadCard
                key={p.id}
                post={p}
                viewerUserId={viewerUserId}
                tagsByName={tagsByName}
                authorAvatarUrl={authorAvatars.get(p.authorId)?.avatarUrl ?? null}
                onOpen={() => openPost(p.id)}
                onTagClick={() => {}}
                onReactionToggle={(emoji) => void handleReactPost(p.id, emoji)}
              />
            ))
          )}
        </div>

        {/* Sidebar */}
        <aside className="flex flex-col gap-4">
          <Card>
            <CardContent className="p-5">
              <h4 className="font-display text-base font-semibold text-text">Acerca del espacio</h4>
              <p className="mt-2 text-sm text-text-muted">{meta?.description}</p>
            </CardContent>
          </Card>

          {otherSpaces.length > 0 && (
            <Card>
              <CardContent className="p-5">
                <h4 className="font-display text-base font-semibold text-text">Otros espacios</h4>
                <div className="mt-3 divide-y divide-border-soft">
                  {otherSpaces.map((s) => (
                    <a
                      key={s.slug}
                      href={`/espacios/${s.slug}`}
                      className="flex items-center gap-2.5 py-2 text-sm text-text-muted transition-colors hover:text-text"
                    >
                      <SpaceIcon icon={s.icon} color={s.color} size={16} />
                      <span>{s.title}</span>
                    </a>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>

      <Dialog
        open={selectedPostId !== null}
        onOpenChange={(open) => {
          if (!open) closePost();
        }}
        ariaLabel="Detalle de la publicación"
        maxWidthClass="max-w-5xl"
        contentClassName="p-6 sm:p-8"
      >
        {selectedPostId ? (
          <PostDetailView
            postId={selectedPostId}
            onClose={closePost}
            onChanged={() => void reload({ sort })}
          />
        ) : null}
      </Dialog>
    </section>
  );
}
