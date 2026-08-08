'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import nextDynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Icon, type IconName } from '@/components/icon';
import { PendingCommentsQueue } from '@/components/pending-comments-queue';

// tiptap (~200KB) solo se baja cuando se abre el editor de metadatos.
const RichTextEditor = nextDynamic(
  () => import('@/components/rich-text-editor').then((m) => m.RichTextEditor),
  { ssr: false, loading: () => <div className="skeleton h-40 w-full rounded-md" /> },
);
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { certificateTemplatesApi, type CertificateTemplate } from '@/modules/certificates';
import { sanitizeRichHtml } from '@/lib/sanitize-html';
import { storageApi } from '@/lib/storage';
import {
  coursesApi,
  type CourseCategory,
  type CourseDetail,
  type CourseLesson,
  type CourseModule,
  type LessonType,
} from '@/lib/courses';
import { LessonContentEditor } from './lesson-content-editor';

// Tipos ofrecidos al crear una lección (SCORM se configura desde el editor de
// contenido). Labels en el catálogo `formadorCursos.lessonType.*`.
const LESSON_TYPE_OPTIONS: LessonType[] = ['VIDEO', 'HTML', 'PDF', 'TEXT', 'QUIZ'];

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
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
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
        setError({ message: apiErrorMessage(e, tErrors), reasons });
      } else {
        setError({ message: t('errorUnexpected') });
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

  async function handleUnarchive() {
    await withRefresh(() => coursesApi.unarchive(initial.id));
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
                // Preview del HTML del editor (sanitizado). Los tags
                // soportados (h2/h3, listas, b, i, links) se ven con la
                // tipografía blanca del hero.
                <div
                  className="prose prose-invert mt-3 max-w-2xl text-sm leading-relaxed text-white/85"
                  dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(initial.description) }}
                />
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
                {editingMetadata ? t('close') : t('edit')}
              </Button>
              <Button asChild variant="ghost" className="text-white hover:bg-white/10">
                <Link href={`/cursos/${initial.slug}` as never}>
                  <Icon name="eye" size={16} />
                  {t('preview')}
                </Link>
              </Button>
              {initial.status === 'DRAFT' ? (
                <Button onClick={handlePublish} disabled={pending}>
                  <Icon name="check" size={16} />
                  {t('publish')}
                </Button>
              ) : null}
              {initial.status !== 'ARCHIVED' ? (
                <Button onClick={handleArchive} variant="outline" disabled={pending}>
                  {t('archive')}
                </Button>
              ) : (
                <Button onClick={handleUnarchive} disabled={pending}>
                  <Icon name="arrow-left" size={16} />
                  {t('unarchive')}
                </Button>
              )}
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
              {t('sectionsWord', { count: initial.modules.length })}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">{totalLessons}</p>
            <p className="text-xs font-medium text-text-muted">
              {t('lessonsWord', { count: totalLessons })}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {totalMinutes > 0 ? `${totalMinutes}` : '—'}
            </p>
            <p className="text-xs font-medium text-text-muted">
              {totalMinutes > 0 ? t('totalMinutesLabel') : t('noDurationLabel')}
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

      {/* === Cola de comentarios pendientes de moderación === */}
      <PendingCommentsQueue courseId={initial.id} />

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
              <CardTitle>{t('courseContentTitle')}</CardTitle>
              <CardDescription>{t('courseContentDescription')}</CardDescription>
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
                {t('emptyModulesTitle')}
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-text-muted">
                {t.rich('emptyModulesHint', {
                  b: (chunks) => <span className="font-semibold">{chunks}</span>,
                })}
              </p>
            </div>
          ) : (
            <ModuleList
              modules={initial.modules}
              courseId={initial.id}
              onChange={onChange}
              onError={(msg) => setError({ message: msg })}
            />
          )}

          <AddModuleForm onAddModule={handleAddModule} pending={pending} />
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * Lista de lecciones de un módulo. Vive dentro del `DndContext` global del
 * `ModuleList`, así que aquí solo declaramos un `SortableContext` con los IDs
 * de las lecciones — el reorden y cross-module drop los maneja el padre.
 */
function LessonList({
  moduleId,
  lessons,
  editingLessonId,
  pending,
  onToggleEdit,
  onDelete,
  onChange,
}: {
  moduleId: string;
  lessons: CourseLesson[];
  editingLessonId: string | null;
  pending: boolean;
  onToggleEdit: (lessonId: string) => void;
  onDelete: (lessonId: string, title: string) => Promise<void>;
  onChange: () => Promise<void>;
}) {
  return (
    <SortableContext items={lessons.map((l) => l.id)} strategy={verticalListSortingStrategy}>
      <ul className="divide-y divide-border-soft">
        {lessons.map((l) => (
          <LessonRow
            key={l.id}
            lesson={l}
            moduleId={moduleId}
            isEditing={editingLessonId === l.id}
            pending={pending}
            onToggleEdit={() => onToggleEdit(l.id)}
            onDelete={() => onDelete(l.id, l.title)}
            onChange={onChange}
          />
        ))}
      </ul>
    </SortableContext>
  );
}

function LessonRow({
  lesson,
  moduleId,
  isEditing,
  pending,
  onToggleEdit,
  onDelete,
  onChange,
}: {
  lesson: CourseLesson;
  moduleId: string;
  isEditing: boolean;
  pending: boolean;
  onToggleEdit: () => void;
  onDelete: () => Promise<void>;
  onChange: () => Promise<void>;
}) {
  const t = useTranslations('formadorCursos');
  // `data.moduleId` permite al onDragEnd global del ModuleList saber a qué
  // sección pertenece esta lección y decidir si es reorden interno o
  // cross-module drop.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lesson.id,
    data: { type: 'lesson', moduleId },
  });
  const iconName = LESSON_TYPE_ICON[lesson.type] ?? 'book';
  const wrapperStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={wrapperStyle}
      className={isDragging ? 'relative z-10 bg-surface shadow-lg ring-1 ring-brand-200' : ''}
    >
      <div
        className={
          isEditing
            ? 'flex flex-wrap items-center gap-3 bg-surface-2 px-4 py-2.5'
            : 'group flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-surface-2'
        }
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('dragLessonAria', { title: lesson.title })}
          title={t('dragTitle')}
          className="cursor-grab touch-none rounded p-0.5 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-muted active:cursor-grabbing"
        >
          <Icon name="grip" size={16} />
        </button>
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
          <p className="truncate text-sm font-medium text-text">{lesson.title}</p>
          <p className="text-xs text-text-subtle">
            {t(`lessonType.${lesson.type}`)}
            {lesson.durationMinutes
              ? ` · ${t('minutesShort', { minutes: lesson.durationMinutes })}`
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onToggleEdit}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-brand-600 transition-colors hover:bg-brand-50"
          >
            <Icon name="edit" size={13} />
            {isEditing ? t('close') : t('edit')}
          </button>
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={pending}
            aria-label={t('deleteLessonAria', { title: lesson.title })}
            title={t('deleteLessonTitle')}
            className="rounded p-1.5 text-text-disabled transition-colors hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      {isEditing ? (
        <div className="border-t border-border-soft bg-surface px-4 py-4">
          <LessonContentEditor lesson={lesson} onUpdated={onChange} onCancel={onToggleEdit} />
        </div>
      ) : null}
    </li>
  );
}

/** Formatea un tamaño en bytes a KB/MB legible (para el aviso de optimización). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
  const [title, setTitle] = useState(course.title);
  const [description, setDescription] = useState(course.description ?? '');
  const [category, setCategory] = useState(course.category ?? '');
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    course.estimatedMinutes ? String(course.estimatedMinutes) : '',
  );
  const [thumbnailUrl, setThumbnailUrl] = useState(course.thumbnailUrl ?? '');
  const [featuredVideoUrl, setFeaturedVideoUrl] = useState(course.featuredVideoUrl ?? '');
  const [externalPurchaseUrl, setExternalPurchaseUrl] = useState(course.externalPurchaseUrl ?? '');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeNote, setOptimizeNote] = useState<string | null>(null);
  const [managedCategories, setManagedCategories] = useState<CourseCategory[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingImage(true);
    setError(null);
    setOptimizeNote(null);
    try {
      // El backend optimiza a WebP; 1600px basta para el hero del curso.
      const result = await storageApi.uploadImage(file, { optimize: { maxWidth: 1600 } });
      setThumbnailUrl(result.url);
    } catch (err) {
      setError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('errorUploadImage'));
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleOptimizeExisting() {
    if (!thumbnailUrl) return;
    setOptimizing(true);
    setError(null);
    setOptimizeNote(null);
    try {
      const res = await storageApi.optimizeExisting(thumbnailUrl, { maxWidth: 1600 });
      if (res.optimized) {
        setThumbnailUrl(res.url);
        setOptimizeNote(
          t('optimizedNote', {
            previous: formatBytes(res.previousSize),
            size: formatBytes(res.size),
          }),
        );
      } else {
        setOptimizeNote(t('alreadyOptimized'));
      }
    } catch (err) {
      setError(
        err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('errorOptimizeImage'),
      );
    } finally {
      setOptimizing(false);
    }
  }

  useEffect(() => {
    let aborted = false;
    void coursesApi
      .listManagedCategories()
      .then((list) => {
        if (!aborted) setManagedCategories(list);
      })
      .catch(() => {
        // Si falla la carga, el form cae al input libre como fallback.
      });
    return () => {
      aborted = true;
    };
  }, []);

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
        thumbnailUrl: thumbnailUrl.trim() ? thumbnailUrl.trim() : null,
        featuredVideoUrl: featuredVideoUrl.trim() ? featuredVideoUrl.trim() : null,
        externalPurchaseUrl: externalPurchaseUrl.trim() ? externalPurchaseUrl.trim() : null,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorSaveChanges'));
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
            <CardTitle className="text-base">{t('metadataTitle')}</CardTitle>
            <CardDescription>{t('metadataDescription')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="meta-title">
              {t('titleLabel')} <span className="text-danger-700">*</span>
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
            <Label htmlFor="meta-description">{t('descriptionLabel')}</Label>
            <RichTextEditor
              value={description}
              onChange={setDescription}
              placeholder={t('descriptionPlaceholder')}
              ariaLabel={t('descriptionAria')}
            />
            <p className="text-xs text-text-subtle">{t('descriptionHelp')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="meta-category">{t('categoryLabel')}</Label>
              {managedCategories.length > 0 ? (
                <Select
                  id="meta-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">{t('categoryNone')}</option>
                  {managedCategories.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id="meta-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  maxLength={60}
                  placeholder={t('categoryPlaceholder')}
                />
              )}
              {managedCategories.length === 0 ? (
                <p className="text-xs text-text-subtle">
                  {t.rich('categoryTip', { code: (chunks) => <code>{chunks}</code> })}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="meta-estimated">{t('estimatedLabel')}</Label>
              <Input
                id="meta-estimated"
                type="number"
                min={1}
                value={estimatedMinutes}
                onChange={(e) => setEstimatedMinutes(e.target.value)}
                placeholder={t('estimatedPlaceholder')}
              />
            </div>
          </div>

          {/* Media destacada del hero (se muestra al alumno NO inscrito). */}
          <div className="space-y-4 rounded-lg border border-border-soft bg-surface-2 p-4">
            <p className="text-sm font-semibold text-text">{t('heroTitle')}</p>
            <p className="-mt-2 text-xs text-text-subtle">{t('heroHelp')}</p>

            <div className="space-y-1.5">
              <Label htmlFor="meta-thumbnail">{t('thumbnailLabel')}</Label>
              <div className="flex flex-wrap items-center gap-3">
                {thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbnailUrl}
                    alt={t('thumbnailAlt')}
                    className="aspect-video w-28 rounded-md border border-border bg-subtle object-contain"
                  />
                ) : (
                  <div className="grid aspect-video w-28 place-items-center rounded-md border border-dashed border-border-strong text-xs text-text-subtle">
                    {t('noImage')}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    id="meta-thumbnail"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={handleImageChange}
                    className="block w-full text-xs text-text-muted file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-brand-700"
                  />
                  {thumbnailUrl ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleOptimizeExisting()}
                        disabled={uploadingImage || optimizing}
                        title={t('optimizeTooltip')}
                      >
                        {optimizing ? t('optimizing') : t('optimize')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setThumbnailUrl('');
                          setOptimizeNote(null);
                        }}
                        disabled={uploadingImage || optimizing}
                      >
                        {t('remove')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              {uploadingImage ? (
                <p className="text-xs text-text-subtle">{t('uploadingImage')}</p>
              ) : optimizeNote ? (
                <p className="text-xs text-success-700">{optimizeNote}</p>
              ) : (
                <p className="text-xs text-text-subtle">{t('imageHelp')}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meta-featured-video">{t('featuredVideoLabel')}</Label>
              <Input
                id="meta-featured-video"
                type="url"
                value={featuredVideoUrl}
                onChange={(e) => setFeaturedVideoUrl(e.target.value)}
                placeholder={t('featuredVideoPlaceholder')}
              />
              <p className="text-xs text-text-subtle">
                {t.rich('featuredVideoHelp', { code: (chunks) => <code>{chunks}</code> })}
              </p>
            </div>
          </div>

          <div className="space-y-4 rounded-lg border border-border-soft p-4">
            <div className="space-y-1.5">
              <Label htmlFor="meta-external-purchase">{t('externalPurchaseLabel')}</Label>
              <Input
                id="meta-external-purchase"
                type="url"
                value={externalPurchaseUrl}
                onChange={(e) => setExternalPurchaseUrl(e.target.value)}
                placeholder={t('externalPurchasePlaceholder')}
              />
              <p className="text-xs text-text-subtle">
                {t.rich('externalPurchaseHelp', { code: (chunks) => <code>{chunks}</code> })}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="meta-course-id">{t('courseIdLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  id="meta-course-id"
                  value={course.id}
                  readOnly
                  className="flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(course.id);
                    setCopiedId(true);
                    window.setTimeout(() => setCopiedId(false), 1500);
                  }}
                >
                  {copiedId ? t('copied') : t('copy')}
                </Button>
              </div>
              <p className="text-xs text-text-subtle">
                {t.rich('courseIdHelp', { code: (chunks) => <code>{chunks}</code> })}
              </p>
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
              {pending ? t('saving') : t('saveChanges')}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              {t('cancel')}
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
  const t = useTranslations('formadorCursos');
  const checks = [
    { ok: course.title.trim().length > 0, label: t('checkTitle') },
    { ok: !!course.description?.trim(), label: t('checkDescription') },
    { ok: course.modules.length > 0, label: t('checkModule') },
    { ok: totalLessons > 0, label: t('checkLesson') },
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
              {allDone ? t('readyToPublish') : t('beforePublish')}
            </h3>
            <p className="mt-0.5 text-xs text-text-muted">
              {allDone ? t('readyToPublishHelp') : t('beforePublishHelp')}
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

/**
 * Wrapper DnD para la lista de módulos del curso.
 *
 * - Usa state local optimistic para que el reorden se vea instantáneo, y
 *   llama a `coursesApi.reorderModules` con la lista final.
 * - Tras la respuesta del backend, llama a `onChange()` para resync con la
 *   verdad del servidor (que puede haber renumerado posiciones).
 * - Si la API falla, refresca para recuperar el orden correcto y propaga
 *   un mensaje al editor padre.
 */
/**
 * Wrapper único de DnD para módulos + lecciones del curso.
 *
 * Filosofía:
 * - UN solo `DndContext` para que el cross-module drop funcione (arrastrar
 *   una lección de la sección A a la B).
 * - State local optimistic con la jerarquía completa (módulos + lecciones)
 *   para que el reorden se vea instantáneo.
 * - `active.data.current.type` distingue 'module' vs 'lesson' en `onDragEnd`.
 *
 * Casos en `onDragEnd`:
 * 1. module → module: `reorderModules`.
 * 2. lesson → lesson en el MISMO módulo: `reorderLessons` solo de ese módulo.
 * 3. lesson → lesson en OTRO módulo: `moveLessonToModule` con la posición
 *    relativa dentro del módulo destino.
 * 4. lesson → module (drop sobre header de un módulo, no sobre lección):
 *    `moveLessonToModule` con position al final.
 */
function ModuleList({
  modules,
  courseId,
  onChange,
  onError,
}: {
  modules: CourseModule[];
  courseId: string;
  onChange: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
  const [optimistic, setOptimistic] = useState<CourseModule[]>(modules);

  useEffect(() => {
    setOptimistic(modules);
  }, [modules]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeType = active.data.current?.type as 'module' | 'lesson' | undefined;
    const overType = over.data.current?.type as 'module' | 'lesson' | undefined;

    // Caso 1: reordenar módulos.
    if (activeType === 'module' && overType === 'module') {
      const oldIdx = optimistic.findIndex((m) => m.id === active.id);
      const newIdx = optimistic.findIndex((m) => m.id === over.id);
      if (oldIdx === -1 || newIdx === -1) return;
      const reordered = arrayMove(optimistic, oldIdx, newIdx);
      setOptimistic(reordered);
      try {
        await coursesApi.reorderModules(
          courseId,
          reordered.map((m) => m.id),
        );
        await onChange();
      } catch (e) {
        onError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorReorderModules'));
        await onChange();
      }
      return;
    }

    // Caso 2-4: lección.
    if (activeType !== 'lesson') return;

    const sourceModuleId = active.data.current?.moduleId as string | undefined;
    if (!sourceModuleId) return;

    let targetModuleId: string | undefined;
    let targetLessonId: string | undefined;
    if (overType === 'lesson') {
      targetModuleId = over.data.current?.moduleId as string | undefined;
      targetLessonId = String(over.id);
    } else if (overType === 'module') {
      // Drop sobre la card del módulo (no sobre una lección concreta) → al final.
      targetModuleId = String(over.id);
    }
    if (!targetModuleId) return;

    if (sourceModuleId === targetModuleId) {
      // Mismo módulo → reorden interno.
      const moduleIdx = optimistic.findIndex((m) => m.id === sourceModuleId);
      if (moduleIdx === -1) return;
      const lessons = optimistic[moduleIdx]!.lessons;
      const oldIdx = lessons.findIndex((l) => l.id === active.id);
      const newIdx = targetLessonId
        ? lessons.findIndex((l) => l.id === targetLessonId)
        : lessons.length - 1;
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
      const reorderedLessons = arrayMove(lessons, oldIdx, newIdx);
      const next = [...optimistic];
      next[moduleIdx] = { ...next[moduleIdx]!, lessons: reorderedLessons };
      setOptimistic(next);
      try {
        await coursesApi.reorderLessons(
          sourceModuleId,
          reorderedLessons.map((l) => l.id),
        );
        await onChange();
      } catch (e) {
        onError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorReorderLessons'));
        await onChange();
      }
      return;
    }

    // Cross-module: la lección cambia de sección.
    const sourceIdx = optimistic.findIndex((m) => m.id === sourceModuleId);
    const targetIdx = optimistic.findIndex((m) => m.id === targetModuleId);
    if (sourceIdx === -1 || targetIdx === -1) return;
    const sourceLessons = optimistic[sourceIdx]!.lessons;
    const lessonToMove = sourceLessons.find((l) => l.id === active.id);
    if (!lessonToMove) return;

    const newSourceLessons = sourceLessons.filter((l) => l.id !== active.id);
    const targetLessons = optimistic[targetIdx]!.lessons;
    let insertAt = targetLessons.length;
    if (targetLessonId) {
      insertAt = Math.max(
        0,
        targetLessons.findIndex((l) => l.id === targetLessonId),
      );
    }
    const newTargetLessons = [
      ...targetLessons.slice(0, insertAt),
      { ...lessonToMove, moduleId: targetModuleId },
      ...targetLessons.slice(insertAt),
    ];

    const next = [...optimistic];
    next[sourceIdx] = { ...next[sourceIdx]!, lessons: newSourceLessons };
    next[targetIdx] = { ...next[targetIdx]!, lessons: newTargetLessons };
    setOptimistic(next);

    try {
      await coursesApi.moveLessonToModule(String(active.id), targetModuleId, insertAt);
      await onChange();
    } catch (e) {
      onError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorMoveLesson'));
      await onChange();
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={optimistic.map((m) => m.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-4">
          {optimistic.map((m, idx) => (
            <ModuleBlock key={m.id} courseModule={m} index={idx} onChange={onChange} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function ModuleBlock({
  courseModule,
  index,
  onChange,
}: {
  courseModule: CourseModule;
  index: number;
  onChange: () => Promise<void>;
}) {
  const t = useTranslations('formadorCursos');
  const [pending, setPending] = useState(false);
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null);
  const [showAddLesson, setShowAddLesson] = useState(false);

  // Sortable state — el handle es el `<button>` con icon `grip` del header.
  // `data.type='module'` permite al `onDragEnd` global distinguir módulos vs
  // lecciones, y soportar drop de una lección sobre la card del módulo
  // (cross-module al final del módulo destino).
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: courseModule.id,
    data: { type: 'module' },
  });

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

  async function handleDeleteLesson(lessonId: string, lessonTitle: string) {
    const confirmed = window.confirm(t('confirmDeleteLesson', { title: lessonTitle }));
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
      t('confirmDeleteModule', {
        title: courseModule.title,
        count: courseModule.lessons.length,
      }),
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

  const wrapperStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={wrapperStyle}
      className={
        isDragging
          ? 'overflow-hidden rounded-xl border border-brand-300 bg-surface opacity-70 shadow-xl ring-2 ring-brand-200'
          : 'overflow-hidden rounded-xl border border-border bg-surface'
      }
    >
      <header className="flex flex-wrap items-start gap-3 border-b border-border-soft bg-surface-2 px-4 py-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('dragModuleAria')}
          title={t('dragTitle')}
          className="cursor-grab touch-none rounded p-0.5 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-muted active:cursor-grabbing"
        >
          <Icon name="grip" size={18} />
        </button>
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
            {t('lessonsWithCount', { count: courseModule.lessons.length })}
          </span>
          {moduleMinutes > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Icon name="clock" size={12} />
                {t('minutesShort', { minutes: moduleMinutes })}
              </span>
            </>
          ) : null}
          <button
            type="button"
            onClick={handleDeleteModule}
            disabled={pending}
            aria-label={t('deleteModuleAria')}
            title={t('deleteModuleAria')}
            className="rounded p-1 text-text-disabled transition-colors hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </header>

      {courseModule.lessons.length > 0 ? (
        <LessonList
          moduleId={courseModule.id}
          lessons={courseModule.lessons}
          editingLessonId={editingLessonId}
          pending={pending}
          onToggleEdit={(id) => setEditingLessonId(editingLessonId === id ? null : id)}
          onDelete={handleDeleteLesson}
          onChange={onChange}
        />
      ) : (
        <p className="border-b border-border-soft bg-surface-2 px-4 py-6 text-center text-xs italic text-text-subtle">
          {t('noLessonsYet')}
        </p>
      )}

      {showAddLesson ? (
        <form action={handleAddLesson} className="border-t border-border-soft bg-surface-2 p-4">
          <div className="grid gap-2 sm:grid-cols-12">
            <div className="sm:col-span-2">
              <Label htmlFor={`type-${courseModule.id}`} className="sr-only">
                {t('typeLabel')}
              </Label>
              <Select id={`type-${courseModule.id}`} name="type" required defaultValue="TEXT">
                {LESSON_TYPE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`lessonType.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            <Input
              name="title"
              placeholder={t('lessonTitlePlaceholder')}
              required
              autoFocus
              className="sm:col-span-7"
            />
            <Input
              name="durationMinutes"
              type="number"
              min={1}
              placeholder={t('minPlaceholder')}
              className="sm:col-span-1"
            />
            <Button type="submit" size="sm" disabled={pending} className="sm:col-span-2">
              {t('create')}
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setShowAddLesson(false)}
            className="mt-2 text-xs font-semibold text-text-muted hover:text-text"
          >
            {t('cancel')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowAddLesson(true)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-border-soft bg-surface px-4 py-3 text-sm font-semibold text-text-muted transition-colors hover:bg-surface-2 hover:text-brand-700"
        >
          <Icon name="plus" size={16} />
          {t('addLesson')}
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
  const t = useTranslations('formadorCursos');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong bg-surface-2 px-4 py-4 text-sm font-semibold text-text-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
      >
        <Icon name="plus" size={18} />
        {t('addModule')}
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
        {t('newModule')}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input name="title" required autoFocus placeholder={t('moduleTitlePlaceholder')} />
        <Input
          name="description"
          placeholder={t('moduleDescriptionPlaceholder')}
          className="sm:col-span-2"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {t('createModule')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
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
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
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
          setError(
            e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorLoadTemplates'),
          );
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
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorSaveTemplate'));
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
            <CardTitle className="text-base">{t('certTemplateTitle')}</CardTitle>
            <CardDescription>
              {t('certTemplateDescription')}
              {defaultName ? (
                <>
                  {' '}
                  {t.rich('certTemplateCurrent', {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    name: defaultName,
                  })}
                </>
              ) : null}
              .
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1.5">
          <Label htmlFor="cert-template">{t('templateLabel')}</Label>
          <Select
            id="cert-template"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={templates === null}
          >
            <option value="">{t('templateDefaultOption')}</option>
            {(templates ?? []).map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.isDefault ? t('templateNameDefault', { name: tpl.name }) : tpl.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="button" onClick={handleSave} disabled={!dirty || busy}>
          {busy ? t('saving') : t('save')}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/formador/certificados/templates">{t('manageTemplates')}</Link>
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
