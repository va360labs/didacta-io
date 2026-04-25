'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { communityApi, type Post } from '@/lib/community';

export default function ComunidadPage() {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function reload() {
    try {
      setPosts(await communityApi.listPosts());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al cargar posts');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleCreate(form: FormData) {
    setPending(true);
    setError(null);
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
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al crear post');
    } finally {
      setPending(false);
    }
  }

  if (error && !posts)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!posts) return <p className="text-sm text-neutral-500">Cargando…</p>;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Comunidad</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Posts, preguntas y discusiones del tenant. Todos los usuarios pueden publicar.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nuevo post</CardTitle>
          <CardDescription>Comparte una pregunta, idea o anuncio.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={handleCreate} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="title">Título</Label>
              <Input id="title" name="title" required minLength={3} maxLength={200} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="body">Contenido</Label>
              <Textarea id="body" name="body" rows={4} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tags">Tags (separados por coma)</Label>
              <Input id="tags" name="tags" placeholder="general, ayuda, anuncios" />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Publicando…' : 'Publicar'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {posts.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Aún no hay posts. ¡Sé el primero!
        </p>
      ) : (
        <ul className="space-y-3">
          {posts.map((p) => (
            <li key={p.id}>
              <Link
                href={`/comunidad/${p.id}`}
                className="block rounded-md border border-neutral-200 p-4 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                <p className="text-base font-medium">{p.title}</p>
                <p className="mt-1 line-clamp-2 text-sm text-neutral-600 dark:text-neutral-400">
                  {p.body}
                </p>
                <p className="mt-2 text-xs text-neutral-500">
                  por {p.authorDisplayName ?? 'anónimo'} · {new Date(p.createdAt).toLocaleString()}
                </p>
                {p.tags.length > 0 ? (
                  <p className="mt-2">
                    {p.tags.map((t) => (
                      <span
                        key={t}
                        className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                      >
                        #{t}
                      </span>
                    ))}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
