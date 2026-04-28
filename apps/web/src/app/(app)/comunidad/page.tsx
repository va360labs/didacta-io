'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MentionTextarea } from '@/components/mention-textarea';
import { ApiHttpError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { communityApi, type Post, type PostSort } from '@/lib/community';

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

  async function reload(nextSort: PostSort = sort) {
    try {
      setPosts(await communityApi.listPosts({ sort: nextSort }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar la comunidad.');
    }
  }

  useEffect(() => {
    void reload(sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  // Tags presentes en los posts → chips de filtro.
  const allTags = useMemo(() => {
    if (!posts) return ['Todo'];
    const set = new Set<string>(['Todo']);
    for (const p of posts) for (const t of p.tags) set.add(t);
    return Array.from(set).slice(0, 6);
  }, [posts]);

  const filtered = useMemo(() => {
    if (!posts) return [];
    if (activeTag === 'Todo') return posts;
    return posts.filter((p) => p.tags.includes(activeTag));
  }, [posts, activeTag]);

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
      await reload();
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
        <Button onClick={() => setShowCompose((s) => !s)}>
          <Icon name="plus" size={16} />
          {showCompose ? 'Cancelar' : 'Nueva conversación'}
        </Button>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        {/* Feed */}
        <div className="flex flex-col gap-4">
          {showCompose ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Nueva conversación</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreate} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="title">Título</Label>
                    <Input id="title" name="title" required minLength={3} maxLength={200} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="body">Contenido</Label>
                    <MentionTextarea id="body" name="body" rows={4} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tags">Tags (separados por coma)</Label>
                    <Input id="tags" name="tags" placeholder="general, ayuda, anuncios" />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={pending}>
                      {pending ? 'Publicando…' : 'Publicar'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setShowCompose(false)}
                      disabled={pending}
                    >
                      Cancelar
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          ) : null}

          {/* Filtros tipo chip */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setActiveTag(t)}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
                    activeTag === t
                      ? 'bg-[var(--didacta-night)] text-white'
                      : 'bg-[var(--didacta-surface)] text-text-muted hover:text-text',
                  )}
                >
                  {t}
                </button>
              ))}
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
              <CardContent className="p-12 text-center text-sm text-text-muted">
                {activeTag === 'Todo'
                  ? 'Aún no hay conversaciones. Empezá vos: hace click en "Nueva conversación".'
                  : `Sin conversaciones con el tag "${activeTag}".`}
              </CardContent>
            </Card>
          ) : (
            filtered.map((p) => <ThreadCard key={p.id} post={p} />)
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
                  .map((t, i) => (
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
                          background: TAG_COLORS[i % TAG_COLORS.length],
                          opacity: 0.18,
                        }}
                      />
                      <span className="flex-1 text-sm font-medium text-text">{t}</span>
                      <span className="text-xs text-text-subtle tabular-nums">
                        {posts?.filter((p) => p.tags.includes(t)).length ?? 0}
                      </span>
                    </div>
                  ))}
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

function ThreadCard({ post }: { post: Post }) {
  const initials = (post.authorDisplayName ?? 'A')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <Link
      href={`/comunidad/${post.id}` as never}
      className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
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
                <span className="text-sm font-semibold text-text">
                  {post.authorDisplayName ?? 'Anónimo'}
                </span>
                {post.tags.slice(0, 2).map((t) => (
                  <Badge key={t} variant="info">
                    {t}
                  </Badge>
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
              {/* Heurística: si el body tiene > 240 caracteres es muy probable
                  que line-clamp-4 esté truncando contenido visible. Mostramos
                  "Leer más" para que el alumno sepa que hay más. El Link
                  padre del card ya navega al detalle (en una iteración
                  futura, el detalle abre como modal sobre el feed). */}
              {post.body.length > 240 ? (
                <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700">
                  Leer más →
                </span>
              ) : null}
              <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-text-muted">
                <Icon name="message" size={14} />
                {post._count && post._count.comments > 0
                  ? `${post._count.comments} ${post._count.comments === 1 ? 'comentario' : 'comentarios'}`
                  : 'Ver conversación'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
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
