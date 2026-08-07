'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { coursesApi, type Course } from '@/lib/courses';
import { apiErrorMessage } from '@/lib/i18n/api-error';

// Carga diferida del editor (tiptap ~200KB): solo se baja cuando se monta el
// formulario, no en el bundle base.
const RichTextEditor = dynamic(
  () => import('@/components/rich-text-editor').then((m) => m.RichTextEditor),
  { ssr: false, loading: () => <div className="skeleton h-40 w-full rounded-md" /> },
);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

interface Props {
  /** Disparado al crear el curso. Recibe el curso creado para que el caller decida qué hacer (ej. navegar al builder). */
  onCreated: (course: Course) => void;
  onCancel?: () => void;
}

export function NewCourseForm({ onCreated, onCancel }: Props) {
  const t = useTranslations('playersContenido');
  const tErrors = useTranslations('errors');
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
      onCreated(course);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  const slugValid = slug.length > 0 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug);

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="title">
          {t.rich('newCourse.titleLabel', {
            req: (chunks) => <span className="text-danger-700">{chunks}</span>,
          })}
        </Label>
        <Input
          id="title"
          name="title"
          required
          maxLength={160}
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder={t('newCourse.titlePlaceholder')}
          autoFocus
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="slug">
          {t.rich('newCourse.slugLabel', {
            req: (chunks) => <span className="text-danger-700">{chunks}</span>,
          })}
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
            placeholder={t('newCourse.slugPlaceholder')}
          />
          {slug && slugValid ? (
            <span className="pr-3 text-success-700">
              <Icon name="check" size={14} />
            </span>
          ) : null}
        </div>
        <p className="text-xs text-text-subtle">{t('newCourse.slugHelp')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">{t('newCourse.descriptionLabel')}</Label>
        <RichTextEditor
          value={description}
          onChange={setDescription}
          placeholder={t('newCourse.descriptionPlaceholder')}
          ariaLabel={t('newCourse.descriptionAriaLabel')}
        />
        <p className="text-xs text-text-subtle">{t('newCourse.descriptionHelp')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="category">{t('newCourse.categoryLabel')}</Label>
          <Input
            id="category"
            name="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={t('newCourse.categoryPlaceholder')}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="estimatedMinutes">{t('newCourse.estimatedMinutesLabel')}</Label>
          <Input
            id="estimatedMinutes"
            name="estimatedMinutes"
            type="number"
            min={1}
            value={estimatedMinutes}
            onChange={(e) => setEstimatedMinutes(e.target.value)}
            placeholder={t('newCourse.estimatedMinutesPlaceholder')}
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

      <div className="flex items-center justify-end gap-2 border-t border-border-soft pt-4">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            {t('newCourse.cancel')}
          </Button>
        ) : null}
        <Button type="submit" disabled={pending || !title || !slugValid}>
          {pending ? t('newCourse.submitPending') : t('newCourse.submit')}
        </Button>
      </div>
    </form>
  );
}
