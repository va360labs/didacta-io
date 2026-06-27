'use client';

import { use, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { CommunityAvatar } from '@/components/community-avatar';
import { ThreadCard } from '@/components/community-thread-card';
import { PostDetailView } from '@/components/post-detail-view';
import { authStorage } from '@/lib/auth-storage';
import { fetchPublicProfile, type PublicProfile } from '@/lib/public-users';
import { communityApi, useCommunityTags, type Post } from '@/modules/community';

/**
 * Perfil público de un usuario del tenant (`/u/[id]`). Se llega pulsando el
 * nombre/avatar de un autor en la comunidad. Muestra los datos públicos
 * (avatar, nombre, cargo, departamento, ubicación, bio) + sus publicaciones.
 * Solo lectura; respeta el tenant (el backend filtra).
 */
export default function PublicProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const viewerUserId = authStorage.getSession()?.user.id ?? null;
  const tagsByName = useCommunityTags();

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setMissing(false);
    setProfile(null);
    setPosts(null);
    void fetchPublicProfile(id).then((p) => {
      if (aborted) return;
      if (!p) {
        setMissing(true);
        setLoading(false);
        return;
      }
      setProfile(p);
      setLoading(false);
    });
    void communityApi
      .listPosts({ authorId: id, limit: 50 })
      .then((ps) => {
        if (!aborted) setPosts(ps);
      })
      .catch(() => {
        if (!aborted) setPosts([]);
      });
    return () => {
      aborted = true;
    };
  }, [id]);

  function reloadPosts() {
    void communityApi
      .listPosts({ authorId: id, limit: 50 })
      .then(setPosts)
      .catch(() => {});
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-40 w-full" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  if (missing || !profile) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-text-muted">
          No encontramos este perfil en tu organización.
        </CardContent>
      </Card>
    );
  }

  const meta = [profile.jobTitle, profile.department, profile.location].filter(Boolean).join(' · ');

  return (
    <section className="space-y-6">
      {/* Cabecera del perfil */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <CommunityAvatar
              name={profile.name}
              avatarUrl={profile.avatarUrl}
              size={72}
              linkToProfile={false}
            />
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl font-bold tracking-tight text-text">
                {profile.name ?? 'Usuario'}
              </h1>
              {meta ? <p className="mt-0.5 text-sm text-text-muted">{meta}</p> : null}
              {profile.bio ? (
                <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-text-muted">
                  {profile.bio}
                </p>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Publicaciones del usuario */}
      <div>
        <h2 className="mb-3 font-display text-lg font-semibold text-text">Publicaciones</h2>
        <div className="space-y-4">
          {posts === null ? (
            <div className="skeleton h-32 w-full" />
          ) : posts.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-sm text-text-muted">
                {profile.name ?? 'Este usuario'} aún no ha publicado nada.
              </CardContent>
            </Card>
          ) : (
            posts.map((p) => (
              <ThreadCard
                key={p.id}
                post={p}
                viewerUserId={viewerUserId}
                tagsByName={tagsByName}
                authorAvatarUrl={profile.avatarUrl}
                onOpen={() => setSelectedPostId(p.id)}
                onTagClick={() => {}}
                onReactionToggle={() => {}}
              />
            ))
          )}
        </div>
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
            onChanged={reloadPosts}
          />
        ) : null}
      </Dialog>
    </section>
  );
}
