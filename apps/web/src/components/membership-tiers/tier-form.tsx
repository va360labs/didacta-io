'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { MembershipAdminTier } from '@/lib/membership';
import { cn } from '@/lib/utils';
import {
  TIER_DESCRIPTION_MAX,
  TIER_NAME_MAX,
  tierDraftFromTier,
  validateTierDraft,
  type TierDraft,
} from './tier-helpers';
import { TIER_STYLES, useTierTexts, type TiersVariant } from './tier-ui';

/**
 * Alta o edición de un nivel: nombre, frase de lo que incluye y sus cursos
 * («todos», también los que se publiquen después, o los elegidos). El tipo de
 * contenido se fija al crearlo (la API no deja pasar de «todos» a «elegidos»):
 * al editar se ve, pero no se cambia.
 */
export function TierForm({
  variant,
  tier,
  isFree,
  courses,
  showLegacyNotice,
  busy,
  onSubmit,
  onCancel,
}: {
  variant: TiersVariant;
  /** Nivel que se edita, o `null` para crear uno. */
  tier: MembershipAdminTier | null;
  /** Al crear: el nivel gratis (sin precios; se entra con el registro gratis). */
  isFree: boolean;
  /** Cursos publicados del aula (los que se pueden elegir). */
  courses: readonly { id: string; title: string }[];
  /** Primer nivel de pago de un aula que ya vendía: sus precios pasan a este nivel. */
  showLegacyNotice: boolean;
  busy: boolean;
  /** Guarda; devuelve el error que hay que enseñar, o `null` si fue bien. */
  onSubmit: (draft: TierDraft) => Promise<string | null>;
  onCancel: () => void;
}) {
  const t = useTierTexts(variant);
  const s = TIER_STYLES[variant];
  const creating = tier === null;
  const free = tier ? tier.isFree : isFree;
  const [draft, setDraft] = useState<TierDraft>(() =>
    tier
      ? tierDraftFromTier(tier)
      : {
          name: isFree ? t('tierForm.freeDefaultName') : '',
          description: '',
          // De pago: todo el catálogo; el gratis, solo lo que se elija (no se
          // regala todo sin querer). Sin cursos publicados no hay qué elegir.
          content: isFree && courses.length > 0 ? 'choose' : 'all',
          courseIds: [],
        },
  );
  const [error, setError] = useState<string | null>(null);

  const title = tier
    ? t('tierForm.editTitle', { name: tier.name })
    : free
      ? t('tierForm.freeTitle')
      : t('tierForm.newTitle');

  function toggleCourse(id: string, checked: boolean) {
    setDraft((d) => ({
      ...d,
      courseIds: checked ? [...d.courseIds, id] : d.courseIds.filter((c) => c !== id),
    }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateTierDraft(draft, { coursesAvailable: courses.length > 0 });
    if (invalid) {
      setError(invalid === 'name' ? t('tierForm.nameRequired') : t('tierForm.coursesRequired'));
      return;
    }
    setError(null);
    setError(await onSubmit(draft));
  }

  return (
    <form
      className={s.form}
      onSubmit={(e) => void submit(e)}
      aria-label={title}
      data-testid="nivel-formulario"
    >
      <p className={cn('font-semibold text-text', s.span)}>{title}</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="nivel-nombre">{t('tierForm.nameLabel')}</Label>
        <Input
          id="nivel-nombre"
          className={s.field}
          value={draft.name}
          maxLength={TIER_NAME_MAX}
          placeholder={free ? undefined : t('tierForm.namePlaceholder')}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>

      <div className={cn('flex flex-col gap-1.5', s.span)}>
        <Label htmlFor="nivel-descripcion">{t('tierForm.descriptionLabel')}</Label>
        <Textarea
          id="nivel-descripcion"
          rows={2}
          className={cn(s.field, 'h-auto min-h-[72px]')}
          value={draft.description}
          maxLength={TIER_DESCRIPTION_MAX}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>

      <fieldset className={cn('flex flex-col gap-2', s.span)}>
        <legend className="mb-1 text-sm font-semibold text-text">
          {t('tierForm.contentLabel')}
        </legend>
        <label className="flex items-start gap-2 text-sm text-text">
          <input
            type="radio"
            name="nivel-contenido"
            value="all"
            data-testid="nivel-todos-los-cursos"
            className="mt-0.5 h-4 w-4 accent-brand-600"
            checked={draft.content === 'all'}
            disabled={busy || !creating}
            onChange={() => setDraft({ ...draft, content: 'all' })}
          />
          <span>{t('tierForm.allCourses')}</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-text">
          <input
            type="radio"
            name="nivel-contenido"
            value="choose"
            data-testid="nivel-elegir-cursos"
            className="mt-0.5 h-4 w-4 accent-brand-600"
            checked={draft.content === 'choose'}
            disabled={busy || !creating}
            onChange={() => setDraft({ ...draft, content: 'choose' })}
          />
          <span>{t('tierForm.chooseCourses')}</span>
        </label>
        {!creating ? (
          <p className="text-[13px] text-text-subtle">{t('tierForm.contentFixed')}</p>
        ) : null}

        {draft.content === 'choose' ? (
          courses.length === 0 ? (
            <p className="text-sm text-text-muted">{t('tierForm.noCourses')}</p>
          ) : (
            <ul className="mt-1 grid gap-1.5 rounded-lg border border-border bg-surface p-3 sm:grid-cols-2">
              {courses.map((c) => (
                <li key={c.id}>
                  <label className="flex items-start gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      id={`nivel-curso-${c.id}`}
                      data-testid={`nivel-curso-${c.id}`}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                      checked={draft.courseIds.includes(c.id)}
                      disabled={busy}
                      onChange={(e) => toggleCourse(c.id, e.target.checked)}
                    />
                    <span className="min-w-0">{c.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </fieldset>

      {creating && free ? (
        <p className={cn('text-sm text-text-muted', s.span)}>{t('tierForm.freeNotice')}</p>
      ) : null}
      {creating && !free && showLegacyNotice ? (
        <p
          role="note"
          className={cn(
            'rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-700',
            s.span,
          )}
          data-testid="nivel-aviso-precios"
        >
          {t('tierForm.legacyNotice')}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className={cn('text-sm text-danger-700', s.span)}>
          {error}
        </p>
      ) : null}

      <div className={cn('flex flex-wrap items-center gap-2', s.span)}>
        <Button type="submit" className={s.primary} disabled={busy} data-testid="nivel-guardar">
          {creating ? t('tierForm.create') : t('tierForm.save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={variant === 'simple' ? 'h-11 rounded-xl' : undefined}
          disabled={busy}
          onClick={onCancel}
        >
          {t('tierForm.cancel')}
        </Button>
      </div>
    </form>
  );
}
