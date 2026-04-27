'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi } from '@/lib/courses';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export default function NuevoCursoPage() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [estimatedMinutes, setEstimatedMinutes] = useState('');

  function handleTitleChange(value: string) {
    setTitle(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const course = await coursesApi.create({
        slug,
        title,
        description: description || undefined,
        category: category || undefined,
        estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
      });
      router.push(`/formador/cursos/${course.id}` as never);
    } catch (e) {
      if (e instanceof ApiHttpError) setError(e.message);
      else setError('Error inesperado');
    } finally {
      setPending(false);
    }
  }

  const slugValid = slug.length > 0 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/formador/cursos">← Volver a mis cursos</Link>
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="book" size={20} />
            </span>
            <div className="min-w-0">
              <CardTitle>Nuevo curso</CardTitle>
              <CardDescription>
                El curso queda en estado borrador hasta que lo publiques. Luego añadís secciones,
                lecciones y contenido.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="title">
                Título <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="title"
                name="title"
                required
                maxLength={160}
                value={title}
                onChange={(e) => handleTitleChange(e.target.value)}
                placeholder="Ej: Introducción a n8n para automatización"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="slug">
                Slug <span className="text-danger-700">*</span>
              </Label>
              <div className="flex items-center gap-2 rounded-md border border-border bg-surface focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-1">
                <span className="select-none pl-3 font-mono text-sm text-text-subtle">/</span>
                <input
                  id="slug"
                  name="slug"
                  required
                  maxLength={100}
                  pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugTouched(true);
                  }}
                  className="flex-1 bg-transparent py-2 pr-3 font-mono text-sm focus:outline-none"
                  placeholder="introduccion-n8n"
                />
                {slug && slugValid ? (
                  <span className="pr-3 text-success-700">
                    <Icon name="check" size={14} />
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-text-subtle">
                Se genera automáticamente desde el título. Usar kebab-case, sin acentos. Es la URL
                pública del curso.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">Descripción</Label>
              <Textarea
                id="description"
                name="description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="¿De qué trata este curso? ¿A quién está dirigido? ¿Qué van a aprender?"
              />
              <p className="text-xs text-text-subtle">
                Recomendado para SEO y para el catálogo. Podés ampliarlo después.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="category">Categoría</Label>
                <Input
                  id="category"
                  name="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Ej: Tecnología"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="estimatedMinutes">Duración estimada (min)</Label>
                <Input
                  id="estimatedMinutes"
                  name="estimatedMinutes"
                  type="number"
                  min={1}
                  value={estimatedMinutes}
                  onChange={(e) => setEstimatedMinutes(e.target.value)}
                  placeholder="Ej: 90"
                />
              </div>
            </div>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
              >
                {error}
              </div>
            ) : null}

            <div className="flex items-center gap-2 border-t border-border-soft pt-4">
              <Button type="submit" disabled={pending || !title || !slugValid}>
                {pending ? 'Creando…' : 'Crear curso'}
              </Button>
              <Button asChild variant="ghost">
                <Link href="/formador/cursos">Cancelar</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
