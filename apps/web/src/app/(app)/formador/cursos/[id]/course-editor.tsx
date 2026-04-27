'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { certificateTemplatesApi, type CertificateTemplate } from '@/lib/certificates';
import { coursesApi, type CourseDetail, type CourseModule, type LessonType } from '@/lib/courses';
import { LessonContentEditor } from './lesson-content-editor';

const LESSON_TYPES: { value: LessonType; label: string }[] = [
  { value: 'VIDEO', label: 'Vídeo' },
  { value: 'HTML', label: 'HTML' },
  { value: 'PDF', label: 'PDF' },
  { value: 'TEXT', label: 'Texto' },
  { value: 'QUIZ', label: 'Quiz' },
];

interface PublishError {
  message: string;
  reasons?: string[];
}

export function CourseEditor({
  initial,
  onChange,
}: {
  initial: CourseDetail;
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<PublishError | null>(null);
  const [pending, setPending] = useState(false);

  async function withRefresh(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    try {
      await action();
      await onChange();
    } catch (e) {
      if (e instanceof ApiHttpError) {
        const reasons =
          (e as unknown as { issues?: { message: string }[] }).issues?.map((i) => i.message) ??
          ((e as unknown as Record<string, unknown>).reasons as string[] | undefined);
        setError({ message: e.message, reasons });
      } else {
        setError({ message: 'Error inesperado' });
      }
    } finally {
      setPending(false);
    }
  }

  async function handleAddModule(form: FormData) {
    await withRefresh(() =>
      coursesApi.addModule(initial.id, {
        title: String(form.get('title')),
        description: form.get('description') ? String(form.get('description')) : undefined,
      }),
    );
  }

  async function handlePublish() {
    await withRefresh(() => coursesApi.publish(initial.id));
  }

  async function handleArchive() {
    await withRefresh(() => coursesApi.archive(initial.id));
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{initial.title}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            slug: {initial.slug}
            {initial.category ? ` · ${initial.category}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <CourseStatusBadge status={initial.status} />
          {initial.status === 'DRAFT' ? (
            <Button onClick={handlePublish} disabled={pending}>
              Publicar
            </Button>
          ) : null}
          {initial.status !== 'ARCHIVED' ? (
            <Button onClick={handleArchive} variant="outline" disabled={pending}>
              Archivar
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <Card>
          <CardContent className="pt-6">
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
              {error.message}
            </p>
            {error.reasons && error.reasons.length > 0 ? (
              <ul className="mt-2 list-disc pl-4 text-sm text-red-700 dark:text-red-400">
                {error.reasons.map((r, idx) => (
                  <li key={`${r}-${idx}`}>{r}</li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <CertificateTemplateCard course={initial} onChange={onChange} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Estructura</CardTitle>
          <CardDescription>
            {initial.modules.length} módulos ·{' '}
            {initial.modules.reduce((acc, m) => acc + m.lessons.length, 0)} lecciones
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {initial.modules.map((m) => (
            <ModuleBlock key={m.id} courseModule={m} onChange={onChange} />
          ))}

          <form
            action={handleAddModule}
            className="space-y-3 rounded-md border border-dashed border-neutral-300 p-4 dark:border-neutral-700"
          >
            <p className="text-sm font-medium">Añadir módulo</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input name="title" required placeholder="Título del módulo" />
              <Input
                name="description"
                placeholder="Descripción (opcional)"
                className="sm:col-span-2"
              />
            </div>
            <Button type="submit" size="sm" disabled={pending} variant="outline">
              Añadir módulo
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

function ModuleBlock({
  courseModule,
  onChange,
}: {
  courseModule: CourseModule;
  onChange: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null);

  async function handleAddLesson(form: FormData) {
    setPending(true);
    try {
      await coursesApi.addLesson(courseModule.id, {
        type: form.get('type') as LessonType,
        title: String(form.get('title')),
        durationMinutes: form.get('durationMinutes')
          ? Number(form.get('durationMinutes'))
          : undefined,
      });
      await onChange();
    } finally {
      setPending(false);
    }
  }

  async function handleMoveLesson(lessonId: string, direction: 'up' | 'down') {
    setPending(true);
    try {
      await coursesApi.moveLesson(lessonId, direction);
      await onChange();
    } finally {
      setPending(false);
    }
  }

  async function handleDeleteModule() {
    const confirmed = window.confirm(
      `¿Eliminar el módulo "${courseModule.title}" y sus ${courseModule.lessons.length} lecciones? Esto es soft-delete: los datos se conservan pero dejarán de mostrarse.`,
    );
    if (!confirmed) return;
    setPending(true);
    try {
      await coursesApi.deleteModule(courseModule.id);
      await onChange();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{courseModule.title}</p>
          {courseModule.description ? (
            <p className="text-xs text-neutral-500">{courseModule.description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500">{courseModule.lessons.length} lecciones</span>
          <button
            type="button"
            onClick={handleDeleteModule}
            disabled={pending}
            className="text-xs text-red-600 underline decoration-dotted hover:decoration-solid"
          >
            Eliminar módulo
          </button>
        </div>
      </header>

      <ul className="mb-3 space-y-2 text-sm">
        {courseModule.lessons.map((l, idx) => (
          <li key={l.id} className="space-y-2">
            <div className="flex items-center justify-between">
              <span>
                <span className="mr-2 inline-block min-w-[3rem] rounded bg-neutral-100 px-1.5 py-0.5 text-center text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                  {l.type}
                </span>
                {l.title}
              </span>
              <div className="flex items-center gap-3">
                {l.durationMinutes ? (
                  <span className="text-xs text-neutral-500">{l.durationMinutes} min</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => handleMoveLesson(l.id, 'up')}
                  disabled={pending || idx === 0}
                  className="text-xs disabled:opacity-30"
                  aria-label="Mover arriba"
                  title="Mover arriba"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => handleMoveLesson(l.id, 'down')}
                  disabled={pending || idx === courseModule.lessons.length - 1}
                  className="text-xs disabled:opacity-30"
                  aria-label="Mover abajo"
                  title="Mover abajo"
                >
                  ▼
                </button>
                <button
                  type="button"
                  onClick={() => setEditingLessonId(editingLessonId === l.id ? null : l.id)}
                  className="text-xs underline decoration-dotted hover:decoration-solid"
                >
                  {editingLessonId === l.id ? 'Cerrar' : 'Editar contenido'}
                </button>
              </div>
            </div>
            {editingLessonId === l.id ? (
              <LessonContentEditor
                lesson={l}
                onUpdated={onChange}
                onCancel={() => setEditingLessonId(null)}
              />
            ) : null}
          </li>
        ))}
      </ul>

      <form action={handleAddLesson} className="grid gap-2 sm:grid-cols-12">
        <div className="sm:col-span-2">
          <Label htmlFor={`type-${courseModule.id}`} className="sr-only">
            Tipo
          </Label>
          <Select id={`type-${courseModule.id}`} name="type" required defaultValue="TEXT">
            {LESSON_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <Input name="title" placeholder="Título de la lección" required className="sm:col-span-7" />
        <Input
          name="durationMinutes"
          type="number"
          min={1}
          placeholder="min"
          className="sm:col-span-1"
        />
        <Button type="submit" size="sm" disabled={pending} className="sm:col-span-2">
          Añadir
        </Button>
      </form>
    </div>
  );
}

function CertificateTemplateCard({
  course,
  onChange,
}: {
  course: CourseDetail;
  onChange: () => Promise<void>;
}) {
  const [templates, setTemplates] = useState<CertificateTemplate[] | null>(null);
  const [selected, setSelected] = useState<string>(course.certificateTemplateId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(course.certificateTemplateId ?? '');
  }, [course.certificateTemplateId]);

  useEffect(() => {
    let cancelled = false;
    certificateTemplatesApi
      .list()
      .then((res) => {
        if (!cancelled) setTemplates(res);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar plantillas.');
          setTemplates([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await coursesApi.update(course.id, {
        certificateTemplateId: selected ? selected : null,
      });
      await onChange();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la plantilla.');
    } finally {
      setBusy(false);
    }
  }

  const dirty = (course.certificateTemplateId ?? '') !== selected;
  const defaultName = templates?.find((t) => t.isDefault)?.name;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Plantilla de certificado</CardTitle>
        <CardDescription>
          Si no elegís ninguna, se usa la default del tenant
          {defaultName ? (
            <>
              {' '}
              (actualmente: <strong>{defaultName}</strong>)
            </>
          ) : null}
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1.5">
          <Label htmlFor="cert-template">Plantilla</Label>
          <Select
            id="cert-template"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={templates === null}
          >
            <option value="">Por defecto del tenant</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </Select>
        </div>
        <Button type="button" onClick={handleSave} disabled={!dirty || busy}>
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/formador/certificados/templates">Gestionar plantillas →</Link>
        </Button>
        {error ? (
          <p role="alert" className="basis-full text-sm text-danger-700">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
