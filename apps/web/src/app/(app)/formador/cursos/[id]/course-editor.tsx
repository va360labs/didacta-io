'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
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

const LESSON_TYPE_LABEL: Record<LessonType, string> = {
  VIDEO: 'Vídeo',
  HTML: 'HTML',
  PDF: 'PDF',
  TEXT: 'Texto',
  QUIZ: 'Quiz',
  SCORM: 'SCORM',
};

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

  const totalLessons = initial.modules.reduce((acc, m) => acc + m.lessons.length, 0);

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{initial.title}</h1>
          <p className="mt-1 text-sm text-text-muted">
            <span className="font-mono">/{initial.slug}</span>
            {initial.category ? <span> · {initial.category}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <CourseStatusBadge status={initial.status} />
          {initial.status === 'DRAFT' ? (
            <Button onClick={handlePublish} disabled={pending}>
              <Icon name="check" size={16} />
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
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700"
        >
          <p className="font-semibold">{error.message}</p>
          {error.reasons && error.reasons.length > 0 ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {error.reasons.map((r, idx) => (
                <li key={`${r}-${idx}`}>{r}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <CertificateTemplateCard course={initial} onChange={onChange} />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <CardTitle className="text-base">Estructura</CardTitle>
              <CardDescription>
                {initial.modules.length} {initial.modules.length === 1 ? 'módulo' : 'módulos'} ·{' '}
                {totalLessons} {totalLessons === 1 ? 'lección' : 'lecciones'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {initial.modules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-sm text-text-muted">
              Todavía no hay módulos. Empezá creando el primero abajo ↓
            </div>
          ) : (
            initial.modules.map((m) => (
              <ModuleBlock key={m.id} courseModule={m} onChange={onChange} />
            ))
          )}

          <form
            action={handleAddModule}
            className="space-y-3 rounded-lg border border-dashed border-border-strong bg-surface-2 p-4"
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-text">
              <Icon name="plus" size={16} />
              Añadir módulo
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input name="title" required placeholder="Título del módulo" />
              <Input
                name="description"
                placeholder="Descripción (opcional)"
                className="sm:col-span-2"
              />
            </div>
            <Button type="submit" size="sm" disabled={pending} variant="outline">
              Crear módulo
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
    <div className="rounded-lg border border-border bg-surface p-4">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-base font-semibold leading-tight text-text">
            {courseModule.title}
          </p>
          {courseModule.description ? (
            <p className="mt-0.5 text-xs text-text-muted">{courseModule.description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-subtle">
            {courseModule.lessons.length}{' '}
            {courseModule.lessons.length === 1 ? 'lección' : 'lecciones'}
          </span>
          <button
            type="button"
            onClick={handleDeleteModule}
            disabled={pending}
            className="text-xs font-semibold text-danger-700 hover:underline disabled:opacity-50"
          >
            Eliminar módulo
          </button>
        </div>
      </header>

      {courseModule.lessons.length > 0 ? (
        <ul className="mb-3 divide-y divide-border-soft rounded-md border border-border-soft bg-surface-2">
          {courseModule.lessons.map((l, idx) => (
            <li key={l.id}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <Badge variant="info" className="font-mono text-[10px] tracking-wider">
                    {LESSON_TYPE_LABEL[l.type] ?? l.type}
                  </Badge>
                  <span className="truncate text-sm text-text">{l.title}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {l.durationMinutes ? (
                    <span className="tabular-nums text-xs text-text-subtle">
                      {l.durationMinutes} min
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleMoveLesson(l.id, 'up')}
                    disabled={pending || idx === 0}
                    className="rounded p-1 text-text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                    aria-label="Mover arriba"
                    title="Mover arriba"
                  >
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m18 15-6-6-6 6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMoveLesson(l.id, 'down')}
                    disabled={pending || idx === courseModule.lessons.length - 1}
                    className="rounded p-1 text-text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                    aria-label="Mover abajo"
                    title="Mover abajo"
                  >
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingLessonId(editingLessonId === l.id ? null : l.id)}
                    className="text-xs font-semibold text-brand-600 hover:underline"
                  >
                    {editingLessonId === l.id ? 'Cerrar' : 'Editar'}
                  </button>
                </div>
              </div>
              {editingLessonId === l.id ? (
                <div className="border-t border-border-soft bg-surface px-3 py-3">
                  <LessonContentEditor
                    lesson={l}
                    onUpdated={onChange}
                    onCancel={() => setEditingLessonId(null)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 rounded-md border border-dashed border-border-soft bg-surface-2 px-3 py-3 text-center text-xs text-text-subtle">
          Sin lecciones. Añadí la primera abajo ↓
        </p>
      )}

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
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name="award" size={18} />
          </span>
          <div className="min-w-0">
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
          </div>
        </div>
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
