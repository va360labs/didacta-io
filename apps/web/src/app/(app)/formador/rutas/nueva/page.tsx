'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { createPath } from '@/lib/learning-paths';

export default function NuevaRutaPage() {
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sequenceType, setSequenceType] = useState<'LINEAR' | 'FLEXIBLE'>('LINEAR');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const path = await createPath({
        title: title.trim(),
        description: description.trim() || undefined,
        sequenceType,
      });
      router.push(`/formador/rutas/${path.id}`);
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? apiErrorMessage(err, tErrors)
          : t('rutaNueva.createError');
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <Link
          href="/formador/rutas"
          className="mb-2 flex items-center gap-1 text-xs text-text-muted hover:text-text"
        >
          {t('rutaNueva.backToPaths')}
        </Link>
        <h1 className="font-display text-2xl font-bold text-text">{t('rutaNueva.title')}</h1>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-xl border border-border bg-surface p-6"
      >
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text" htmlFor="title">
            {t('rutaNueva.titleLabel')} <span className="text-red-400">*</span>
          </label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder={t('rutaNueva.titlePlaceholder')}
            required
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-(--didacta-trust)/40"
          />
          <p className="text-right text-[11px] text-text-muted">{title.length}/120</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text" htmlFor="description">
            {t('rutaNueva.descriptionLabel')}
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder={t('rutaNueva.descriptionPlaceholder')}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-(--didacta-trust)/40"
          />
          <p className="text-right text-[11px] text-text-muted">{description.length}/500</p>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-text">{t('rutaNueva.sequenceTypeLabel')}</p>
          <div className="flex gap-3">
            {(['LINEAR', 'FLEXIBLE'] as const).map((seq) => (
              <label key={seq} className="flex cursor-pointer items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="sequenceType"
                  value={seq}
                  checked={sequenceType === seq}
                  onChange={() => setSequenceType(seq)}
                  className="accent-(--didacta-trust)"
                />
                <span className="font-medium">
                  {seq === 'LINEAR' ? t('rutaNueva.linear') : t('rutaNueva.flexible')}
                </span>
                <span className="text-text-muted text-xs">
                  {seq === 'LINEAR' ? t('rutaNueva.linearHint') : t('rutaNueva.flexibleHint')}
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <Link
            href="/formador/rutas"
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text hover:bg-background"
          >
            {t('rutaNueva.cancel')}
          </Link>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="rounded-lg bg-(--didacta-trust) px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? t('rutaNueva.creating') : t('rutaNueva.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
