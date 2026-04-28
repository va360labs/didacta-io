'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CommunityTagChip } from '@/components/community-tag-chip';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MentionTextarea } from '@/components/mention-textarea';
import { PostDetailView } from '@/components/post-detail-view';
import { PostReactions } from '@/components/post-reactions';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { useCommunityTags } from '@/lib/community-tags';
import { cn } from '@/lib/utils';
import { communityApi, type CommunityTag, type Post, type PostSort } from '@/lib/community';

const SORT_LABELS: Record<PostSort, string> = {
  recent: 'Más recientes',
  oldest: 'Más antiguas',
  most_commented: 'Más comentadas',
};

export default function ComunidadPage() {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [activeTag, setActiveTag] = useState<string>('Todo');
  const [sort, setSort] = useState<PostSort>('recent');
  // Si hay un post seleccionado, su detalle se renderiza en un modal
  // sobre el listado en lugar de navegar a /comunidad/[id]. La ruta
  // independiente sigue funcionando para enlaces compartibles.
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

  // Lista de tags disponibles para los chips. Tomamos los del tenant
  // que vienen en el snapshot actual + el "Todo" inicial. Si hay un
  // activeTag distinto de "Todo" lo aseguramos en la lista (ya que
  // al filtrar puede ser que sólo aparezca ese tag).
  const allTags = useMemo(() => {
    const set = new Set<string>(['Todo']);
    if (posts) for (const p of posts) for (const t of p.tags) set.add(t);
    if (activeTag !== 'Todo') set.add(activeTag);
    return Array.from(set).slice(0, 8);
  }, [posts, activeTag]);

  // El filtrado ahora ocurre en backend (`?tag=`); la UI muestra todos
  // los posts devueltos.
  const filtered = posts ?? [];

  // userId del viewer para resaltar reacciones propias en el listado.
  // Lo leemos de la sesión persistida; si no hay (no debería pasar en
  // /comunidad porque hay JwtAuthGuard), la prop queda null y el feed
  // muestra reacciones sin highlight.
  const viewerUserId = useMemo(() => authStorage.getSession()?.user.id ?? null, []);

  // Tags curados del tenant (color/icono). Si el tag de un post no está en
  // este map, el chip cae al estilo info por defecto. La carga es lazy y
  // cacheada por sesión (ver useCommunityTags).
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

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const tagsRaw = String(form.get('tags') ?? '').trim();
      await communityApi.createPost({
        title: String(form.get('title')),
        body: String(form.get('body')),
        tags: tagsRaw
          ? tagsRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      });
      setShowCompose(false);
      await reload({ sort, tag: activeTag });
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos publicar.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="font-display text-4xl font-extrabold tracking-tight text-text"
            style={{ letterSpacing: '-0.02em' }}
          >
            Comunidad
          </h1>
          <p className="mt-1.5 text-text-muted">
            Conversaciones útiles entre formadores, alumnos y administradores.
          </p>
        </div>
        <Button onClick={() => setShowCompose(true)}>
          <Icon name="plus" size={16} />
          Nueva conversación
        </Button>
      </header>

      <Dialog
        open={showCompose}
        onOpenChange={setShowCompose}
        title="Nueva conversación"
        description="Compártelo con la comunidad. Puedes mencionar a alguien con @."
      >
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="title">Título</Label>
            <Input id="title" name="title" required minLength={3} maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="body">Contenido</Label>
            <MentionTextarea id="body" name="body" rows={5} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tags">Tags (separados por coma)</Label>
            <Input id="tags" name="tags" placeholder="general, ayuda, anuncios" />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger-700">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowCompose(false)}
              disabled={pending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Publicando…' : 'Publicar'}
            </Button>
          </div>
        </form>
      </Dialog>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        {/* Feed */}
        <div className="flex flex-col gap-4">
          {/* Filtros tipo chip */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              {allTags.map((t) => {
                const isActive = activeTag === t;
                const curated = t === 'Todo' ? undefined : tagsByName.get(t);
                // El "Todo" y tags sin curar mantienen el estilo plano del
                // filtro (oscuro al activarse). Tags curados muestran el
                // color del tenant; al activarse, lo intensificamos con
                // ring para dejar claro cuál es el activo.
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
                          style={{
                            background: swatchColor,
                            opacity: 0.18,
                          }}
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
                    Aún no hay tags. Etiquetá tu próxima publicación para organizar la comunidad.
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
        maxWidthClass="max-w-3xl"
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

const TAG_COLORS = ['#1E5AA8', '#18B5A8', '#FF6F61', '#2E7DCE', '#0D1B2A'];

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

function ThreadCard({
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

  // Card clickable que abre el detalle en modal. Para mantener
  // accesibilidad (Enter/Espacio + focus visible) usamos role="button"
  // sobre el wrapper en lugar de un <button> para que los chips de
  // tag y reacciones internos sigan siendo elementos interactivos
  // anidados sin generar HTML inválido (button-in-button).
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
              style={{
                background: 'linear-gradient(135deg, #1E5AA8 0%, #18B5A8 100%)',
              }}
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
              {/* Heurística: si el body tiene > 240 caracteres line-clamp-4
                  está casi seguro recortando contenido. Mostramos "Leer
                  más" para invitar a abrir el modal con el detalle. */}
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

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `hace ${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
}
