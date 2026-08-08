'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { uploadCommunityFile, uploadCommunityImage } from '@/lib/community-upload';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { resourcesApi, type CollectionView, type CreateResourceInput } from './client';

/** Modales de mod.resources: compartir recurso (todos) y colección (staff). */

function ModalShell({
  label,
  title,
  subtitle,
  onClose,
  children,
}: {
  label: string;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('modResources');

  return (
    <div
      className="fixed inset-0 z-(--z-overlay) grid place-items-center overflow-y-auto bg-[#0d1b2a]/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-text">{title}</h2>
              <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('modal.close')}
              className="grid h-8 w-8 place-items-center rounded-lg text-text-subtle hover:bg-bg-subtle hover:text-text"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-border bg-surface p-2.5 text-sm text-text placeholder:text-text-subtle focus:border-border-strong focus:outline-none';

export function ShareResourceModal({
  collections,
  defaultCollectionId,
  onClose,
  onCreated,
}: {
  collections: CollectionView[];
  defaultCollectionId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations('modResources');
  const tErrors = useTranslations('errors');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [collectionId, setCollectionId] = useState(defaultCollectionId ?? collections[0]?.id ?? '');
  const [kind, setKind] = useState<'FILE' | 'LINK'>('FILE');
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setError(null);
    if (title.trim().length < 3) {
      setError(t('share.titleTooShort'));
      return;
    }
    if (!collectionId) {
      setError(t('share.pickCollection'));
      return;
    }
    setBusy(true);
    try {
      let input: CreateResourceInput;
      if (kind === 'FILE') {
        if (!file) {
          setError(t('share.pickFile'));
          setBusy(false);
          return;
        }
        const uploaded = await uploadCommunityFile(file);
        input = {
          collectionId,
          kind,
          title: title.trim(),
          description: description.trim() || undefined,
          url: uploaded.url,
          fileName: uploaded.name,
        };
      } else {
        input = {
          collectionId,
          kind,
          title: title.trim(),
          description: description.trim() || undefined,
          url: link.trim(),
        };
      }
      await resourcesApi.create(input);
      onCreated();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      label={t('share.label')}
      title={t('share.title')}
      subtitle={t('share.subtitle')}
      onClose={onClose}
    >
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="res-title">
          {t('share.titleLabel')}
        </label>
        <input
          id="res-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
          placeholder={t('share.titlePlaceholder')}
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="res-collection">
          {t('share.collectionLabel')}
        </label>
        <select
          id="res-collection"
          value={collectionId}
          onChange={(e) => setCollectionId(e.target.value)}
          className={inputClass}
        >
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-text">{t('share.kindLabel')}</p>
        <div className="flex gap-1.5">
          <Chip
            label={t('share.kindFile')}
            active={kind === 'FILE'}
            onClick={() => setKind('FILE')}
          />
          <Chip
            label={t('share.kindLink')}
            active={kind === 'LINK'}
            onClick={() => setKind('LINK')}
          />
        </div>
      </div>

      {kind === 'FILE' ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text" htmlFor="res-file">
            {t('share.fileLabel')}
          </label>
          <input
            id="res-file"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full text-sm text-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-(--didacta-trust) file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text" htmlFor="res-link">
            {t('share.linkLabel')}
          </label>
          <input
            id="res-link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={t('share.linkPlaceholder')}
            className={inputClass}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="res-desc">
          {t('share.descriptionLabel')}
        </label>
        <textarea
          id="res-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder={t('share.descriptionPlaceholder')}
          className={inputClass}
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('share.cancel')}
        </Button>
        <Button onClick={() => void submit()} disabled={busy}>
          {busy ? t('share.sharing') : t('share.submit')}
        </Button>
      </div>
    </ModalShell>
  );
}

export function CollectionFormModal({
  existing,
  onClose,
  onSaved,
}: {
  /** null = crear; con valor = editar. */
  existing: CollectionView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('modResources');
  const tErrors = useTranslations('errors');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [coverUrl, setCoverUrl] = useState<string | null>(existing?.coverUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickCover(file: File | null) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      setCoverUrl(await uploadCommunityImage(file));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (busy) return;
    setError(null);
    if (title.trim().length < 3) {
      setError(t('collection.titleTooShort'));
      return;
    }
    setBusy(true);
    try {
      if (existing) {
        await resourcesApi.updateCollection(existing.id, {
          title: title.trim(),
          description: description.trim() || null,
          coverUrl,
        });
      } else {
        await resourcesApi.createCollection({
          title: title.trim(),
          description: description.trim() || undefined,
          coverUrl: coverUrl ?? undefined,
        });
      }
      onSaved();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      label={t('collection.label')}
      title={existing ? t('collection.titleEdit') : t('collection.titleNew')}
      subtitle={t('collection.subtitle')}
      onClose={onClose}
    >
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="col-title">
          {t('collection.titleLabel')}
        </label>
        <input
          id="col-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
          placeholder={t('collection.titlePlaceholder')}
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="col-desc">
          {t('collection.descriptionLabel')}
        </label>
        <textarea
          id="col-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder={t('collection.descriptionPlaceholder')}
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="col-cover">
          {t('collection.coverLabel')}
        </label>
        <div
          className="relative grid h-32 place-items-center overflow-hidden rounded-xl border border-border"
          style={{ background: 'linear-gradient(160deg, #0D1B2A 0%, #1E5AA8 100%)' }}
        >
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <p className="text-xs text-white/60">{t('collection.coverEmpty')}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            id="col-cover"
            type="file"
            accept="image/*"
            onChange={(e) => void pickCover(e.target.files?.[0] ?? null)}
            className="w-full text-sm text-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-(--didacta-trust) file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
          />
          {coverUrl ? (
            <Button variant="ghost" size="sm" onClick={() => setCoverUrl(null)} disabled={busy}>
              {t('collection.coverRemove')}
            </Button>
          ) : null}
        </div>
        {uploading ? (
          <p className="text-xs text-text-subtle">{t('collection.coverUploading')}</p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('collection.cancel')}
        </Button>
        <Button onClick={() => void submit()} disabled={busy || uploading}>
          {busy ? t('collection.saving') : existing ? t('collection.save') : t('collection.create')}
        </Button>
      </div>
    </ModalShell>
  );
}

export function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
        active
          ? 'border-transparent bg-(--didacta-trust) text-white'
          : 'border-border text-text-muted hover:border-border-strong hover:text-text'
      }`}
    >
      {label}
    </button>
  );
}
