'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Icon, type IconName } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
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

const LESSON_TYPE_ICON: Record<LessonType, IconName> = {
  VIDEO: 'play',
  HTML: 'code',
  PDF: 'file',
  TEXT: 'book',
  QUIZ: 'help',
  SCORM: 'package',
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
  const [editingMetadata, setEditingMetadata] = useState(false);

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
  const totalMinutes = initial.modules.reduce(
    (acc, m) => acc + m.lessons.reduce((s, l) => s + (l.durationMinutes ?? 0), 0),
    0,
  );

  return (
    <section className="space-y-6">
      {/* === Hero del curso === */}
      <Card className="overflow-hidden p-0">
        <div
          className="relative px-6 py-7 text-white"
          style={{
            background: 'linear-gradient(135deg, #0D1B2A 0%, #1E5AA8 100%)',
          }}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <CourseStatusBadge status={initial.status} />
                {initial.category ? (
                  <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white">
                    {initial.category}
                  </span>
                ) : null}
              </div>
              <h1 className="font-display text-3xl font-bold tracking-tight text-white">
                {initial.title}
              </h1>
              <p className="mt-1 font-mono text-sm text-white/60">/{initial.slug}</p>
              {initial.description ? (
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/85">
                  {initial.description}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                className="text-white hover:bg-white/10"
                onClick={() => setEditingMetadata((v) => !v)}
                aria-expanded={editingMetadata}
              >
                <Icon name="edit" size={16} />
                {editingMetadata ? 'Cerrar' : 'Editar'}
              </Button>
              <Button asChild variant="ghost" className="text-white hover:bg-white/10">
                <Link href={`/cursos/${initial.slug}` as never}>
                  <Icon name="eye" size={16} />
                  Vista previa
                </Link>
              </Button>
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
          </div>
        </div>

        {/* Métricas */}
        <div className="grid grid-cols-3 divide-x divide-border-soft border-t border-border bg-surface-2">
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {initial.modules.length}
            </p>
            <p className="text-xs font-medium text-text-muted">
              {initial.modules.length === 1 ? 'sección' : 'secciones'}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">{totalLessons}</p>
            <p className="text-xs font-medium text-text-muted">
              {totalLessons === 1 ? 'lección' : 'lecciones'}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {totalMinutes > 0 ? `${totalMinutes}` : '—'}
            </p>
            <p className="text-xs font-medium text-text-muted">
              {totalMinutes > 0 ? 'minutos totales' : 'sin duración'}
            </p>
          </div>
        </div>
      </Card>

      {/* === Editor de metadatos (toggleable) === */}
      {editingMetadata ? (
        <MetadataEditor
          course={initial}
          onSaved={async () => {
            await onChange();
            setEditingMetadata(false);
          }}
          onCancel={() => setEditingMetadata(false)}
        />
      ) : null}

      {/* === Checklist de publicación (sólo si DRAFT) === */}
      {initial.status === 'DRAFT' ? (
        <PublishChecklist course={initial} totalLessons={totalLessons} />
      ) : null}

      {/* === Error de publicación === */}
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700"
        >
          <div className="flex items-start gap-2.5">
            <Icon name="alert" size={18} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{error.message}</p>
              {error.reasons && error.reasons.length > 0 ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-5">
                  {error.reasons.map((r, idx) => (
                    <li key={`${r}-${idx}`}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* === Plantilla de certificado === */}
      <CertificateTemplateCard course={initial} onChange={onChange} />

      {/* === Estructura del curso === */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <CardTitle>Contenido del curso</CardTitle>
              <CardDescription>
                Organizá tu curso en secciones (módulos) y dentro de cada sección, lecciones.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {initial.modules.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-border-strong bg-surface-2 px-6 py-12 text-center">
              <div
                aria-hidden="true"
                className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl"
                style={{
                  background: 'var(--didacta-info-bg)',
                  color: 'var(--didacta-info-fg)',
                }}
              >
                <Icon name="book" size={28} />
              </div>
              <h3 className="font-display text-lg font-semibold text-text">
                Empezá creando tu primera sección
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-text-muted">
                Las secciones agrupan lecciones relacionadas. Por ejemplo:{' '}
                <span className="font-semibold">Fundamentos</span>,{' '}
                <span className="font-semibold">Práctica</span>, o{' '}
                <span className="font-semibold">Evaluación final</span>.
              </p>
            </div>
          ) : (
            initial.modules.map((m, idx) => (
              <ModuleBlock
                key={m.id}
                courseModule={m}
                index={idx}
                totalModules={initial.modules.length}
                onChange={onChange}
              />
            ))
          )}

          <AddModuleForm onAddModule={handleAddModule} pending={pending} />
        </CardContent>
      </Card>
    </section>
  );
}

function MetadataEditor({
  course,
  onSaved,
  onCancel,
}: {
  course: CourseDetail;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(course.title);
  const [description, setDescription] = useState(course.description ?? '');
  const [category, setCategory] = useState(course.category ?? '');
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    course.estimatedMinutes ? String(course.estimatedMinutes) : '',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await coursesApi.update(course.id, {
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        category: category.trim() ? category.trim() : null,
        estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : null,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar los cambios.');
    } finally {
      setPending(false);
    }
  }

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
            <Icon name="edit" size={18} />
          </span>
          <div className="min-w-0">
            <CardTitle className="text-base">Editar metadatos del curso</CardTitle>
            <CardDescription>
              El slug y el idioma no se pueden cambiar tras la creación. Para limpiar un campo
              opcional, dejalo vacío.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="meta-title">
              Título <span className="text-danger-700">*</span>
            </Label>
            <Input
              id="meta-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={160}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="meta-description">Descripción</Label>
            <Textarea
              id="meta-description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              placeholder="¿De qué trata este curso? ¿A quién está dirigido?"
            />
            <p className="text-xs text-text-subtle">
              Aparece en el catálogo y bajo el cover del curso.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="meta-category">Categoría</Label>
              <Input
                id="meta-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                maxLength={60}
                placeholder="Ej: Tecnología"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="meta-estimated">Duración estimada (min)</Label>
              <Input
                id="meta-estimated"
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
            <Button type="submit" disabled={pending || !title.trim()}>
              {pending ? 'Guardando…' : 'Guardar cambios'}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PublishChecklist({
  course,
  totalLessons,
}: {
  course: CourseDetail;
  totalLessons: number;
}) {
  const checks = [
    { ok: course.title.trim().length > 0, label: 'Título del curso' },
    { ok: !!course.description?.trim(), label: 'Descripción' },
    { ok: course.modules.length > 0, label: 'Al menos una sección' },
    { ok: totalLessons > 0, label: 'Al menos una lección' },
  ];
  const allDone = checks.every((c) => c.ok);

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
            style={{
              background: allDone ? 'var(--didacta-success-bg)' : 'var(--didacta-info-bg)',
              color: allDone ? 'var(--didacta-success-fg)' : 'var(--didacta-info-fg)',
            }}
          >
            <Icon name={allDone ? 'check' : 'sparkles'} size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-base font-semibold text-text">
              {allDone ? 'Listo para publicar' : 'Antes de publicar'}
            </h3>
            <p className="mt-0.5 text-xs text-text-muted">
              {allDone
                ? 'Todos los requisitos están cumplidos. Podés publicar cuando quieras.'
                : 'Completá estos elementos para que tu curso esté listo:'}
            </p>
            <ul className="mt-3 space-y-1.5">
              {checks.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <Icon
                    name={c.ok ? 'check' : 'circle'}
                    size={16}
                    className={c.ok ? 'text-success-700' : 'text-text-disabled'}
                  />
                  <span className={c.ok ? 'text-text-muted line-through' : 'text-text'}>
                    {c.label}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ModuleBlock({
  courseModule,
  index,
  totalModules,
  onChange,
}: {
  courseModule: CourseModule;
  index: number;
  totalModules: number;
  onChange: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null);
  const [showAddLesson, setShowAddLesson] = useState(false);

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
      setShowAddLesson(false);
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

  async function handleDeleteLesson(lessonId: string, lessonTitle: string) {
    const confirmed = window.confirm(
      `¿Eliminar la lección "${lessonTitle}"? Es soft-delete: los datos se conservan y el progreso histórico de los alumnos no se pierde, pero dejará de mostrarse.`,
    );
    if (!confirmed) return;
    setPending(true);
    try {
      await coursesApi.deleteLesson(lessonId);
      if (editingLessonId === lessonId) setEditingLessonId(null);
      await onChange();
    } finally {
      setPending(false);
    }
  }

  async function handleDeleteModule() {
    const confirmed = window.confirm(
      `¿Eliminar la sección "${courseModule.title}" y sus ${courseModule.lessons.length} lecciones? Esto es soft-delete: los datos se conservan pero dejarán de mostrarse.`,
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

  const moduleLabel = `${index + 1}`.padStart(2, '0');
  const moduleMinutes = courseModule.lessons.reduce((s, l) => s + (l.durationMinutes ?? 0), 0);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <header className="flex flex-wrap items-start gap-3 border-b border-border-soft bg-surface-2 px-4 py-3">
        <span
          aria-hidden="true"
          className="cursor-grab text-text-disabled transition-colors hover:text-text-muted"
          title="Arrastrar para reordenar (próximamente)"
        >
          <Icon name="grip" size={18} />
        </span>
        <span
          aria-hidden="true"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md font-display text-xs font-bold tabular-nums"
          style={{
            background: 'var(--didacta-info-bg)',
            color: 'var(--didacta-info-fg)',
          }}
        >
          {moduleLabel}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold leading-tight text-text">
            {courseModule.title}
          </p>
          {courseModule.description ? (
            <p className="mt-0.5 line-clamp-1 text-xs text-text-muted">
              {courseModule.description}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span className="tabular-nums">
            {courseModule.lessons.length}{' '}
            {courseModule.lessons.length === 1 ? 'lección' : 'lecciones'}
          </span>
          {moduleMinutes > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Icon name="clock" size={12} />
                {moduleMinutes} min
              </span>
            </>
          ) : null}
          <button
            type="button"
            onClick={handleDeleteModule}
            disabled={pending}
            aria-label="Eliminar sección"
            title="Eliminar sección"
            className="rounded p-1 text-text-disabled transition-colors hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </header>

      {courseModule.lessons.length > 0 ? (
        <ul className="divide-y divide-border-soft">
          {courseModule.lessons.map((l, idx) => {
            const iconName = LESSON_TYPE_ICON[l.type] ?? 'book';
            const isEditing = editingLessonId === l.id;
            return (
              <li key={l.id}>
                <div
                  className={
                    isEditing
                      ? 'flex flex-wrap items-center gap-3 bg-surface-2 px-4 py-2.5'
                      : 'group flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-surface-2'
                  }
                >
                  <span
                    aria-hidden="true"
                    className="cursor-grab text-text-disabled transition-colors hover:text-text-muted"
                    title="Arrastrar para reordenar (próximamente)"
                  >
                    <Icon name="grip" size={16} />
                  </span>
                  <span
                    aria-hidden="true"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                    style={{
                      background: 'var(--didacta-neutral-bg)',
                      color: 'var(--didacta-neutral-fg)',
                    }}
                  >
                    <Icon name={iconName} size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{l.title}</p>
                    <p className="text-xs text-text-subtle">
                      {LESSON_TYPE_LABEL[l.type] ?? l.type}
                      {l.durationMinutes ? ` · ${l.durationMinutes} min` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => handleMoveLesson(l.id, 'up')}
                      disabled={pending || idx === 0}
                      className="rounded p-1.5 text-text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
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
                      className="rounded p-1.5 text-text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
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
                      onClick={() => setEditingLessonId(isEditing ? null : l.id)}
                      className="ml-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-brand-600 transition-colors hover:bg-brand-50"
                    >
                      <Icon name="edit" size={13} />
                      {isEditing ? 'Cerrar' : 'Editar'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteLesson(l.id, l.title)}
                      disabled={pending}
                      aria-label={`Eliminar lección ${l.title}`}
                      title="Eliminar lección"
                      className="rounded p-1.5 text-text-disabled transition-colors hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
                {isEditing ? (
                  <div className="border-t border-border-soft bg-surface px-4 py-4">
                    <LessonContentEditor
                      lesson={l}
                      onUpdated={onChange}
                      onCancel={() => setEditingLessonId(null)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="border-b border-border-soft bg-surface-2 px-4 py-6 text-center text-xs italic text-text-subtle">
          Sin lecciones todavía. Añadí la primera abajo.
        </p>
      )}

      {showAddLesson ? (
        <form action={handleAddLesson} className="border-t border-border-soft bg-surface-2 p-4">
          <div className="grid gap-2 sm:grid-cols-12">
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
            <Input
              name="title"
              placeholder="Título de la lección"
              required
              autoFocus
              className="sm:col-span-7"
            />
            <Input
              name="durationMinutes"
              type="number"
              min={1}
              placeholder="min"
              className="sm:col-span-1"
            />
            <Button type="submit" size="sm" disabled={pending} className="sm:col-span-2">
              Crear
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setShowAddLesson(false)}
            className="mt-2 text-xs font-semibold text-text-muted hover:text-text"
          >
            Cancelar
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowAddLesson(true)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-border-soft bg-surface px-4 py-3 text-sm font-semibold text-text-muted transition-colors hover:bg-surface-2 hover:text-brand-700"
        >
          <Icon name="plus" size={16} />
          Añadir lección
        </button>
      )}
    </div>
  );
}

function AddModuleForm({
  onAddModule,
  pending,
}: {
  onAddModule: (form: FormData) => Promise<void>;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong bg-surface-2 px-4 py-4 text-sm font-semibold text-text-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
      >
        <Icon name="plus" size={18} />
        Añadir sección
      </button>
    );
  }

  async function handle(form: FormData) {
    await onAddModule(form);
    setOpen(false);
  }

  return (
    <form
      action={handle}
      className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-text">
        <Icon name="plus" size={16} />
        Nueva sección
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input name="title" required autoFocus placeholder="Título de la sección" />
        <Input name="description" placeholder="Descripción (opcional)" className="sm:col-span-2" />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Crear sección
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
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
