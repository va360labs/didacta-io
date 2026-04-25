'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi } from '@/lib/courses';

export default function NuevoCursoPage() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);
    try {
      const course = await coursesApi.create({
        slug: String(form.get('slug')),
        title: String(form.get('title')),
        description: form.get('description') ? String(form.get('description')) : undefined,
        category: form.get('category') ? String(form.get('category')) : undefined,
        estimatedMinutes: form.get('estimatedMinutes')
          ? Number(form.get('estimatedMinutes'))
          : undefined,
      });
      router.push(`/formador/cursos/${course.id}` as never);
    } catch (e) {
      if (e instanceof ApiHttpError) setError(e.message);
      else setError('Error inesperado');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Nuevo curso</CardTitle>
        <CardDescription>El curso queda en estado borrador hasta que lo publiques.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Título</Label>
            <Input id="title" name="title" required maxLength={160} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="slug">Slug</Label>
            <Input
              id="slug"
              name="slug"
              required
              maxLength={100}
              pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
              placeholder="introduccion-n8n"
            />
            <p className="text-xs text-neutral-500">
              kebab-case, sin acentos. Se usa en la URL del curso.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descripción</Label>
            <Textarea id="description" name="description" rows={4} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="category">Categoría</Label>
              <Input id="category" name="category" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="estimatedMinutes">Duración estimada (min)</Label>
              <Input id="estimatedMinutes" name="estimatedMinutes" type="number" min={1} />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={pending}>
            {pending ? 'Creando…' : 'Crear curso'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
