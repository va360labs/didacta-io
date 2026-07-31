'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { uploadCommunityFile, uploadCommunityImage } from '@/lib/community-upload';
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
              aria-label="Cerrar"
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
      setError('El título necesita al menos 3 caracteres.');
      return;
    }
    if (!collectionId) {
      setError('Elige una colección.');
      return;
    }
    setBusy(true);
    try {
      let input: CreateResourceInput;
      if (kind === 'FILE') {
        if (!file) {
          setError('Selecciona el archivo a subir.');
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
      setError(
        e instanceof ApiHttpError || e instanceof Error
          ? e.message
          : 'No pudimos compartir el recurso.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      label="Compartir recurso"
      title="Compartir recurso"
      subtitle="Un workflow, una skill, una herramienta o una plantilla que le sirva a la comunidad."
      onClose={onClose}
    >
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="res-title">
          Título
        </label>
        <input
          id="res-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
          placeholder="Workflow de captación en n8n"
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="res-collection">
          Colección
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
        <p className="text-sm font-medium text-text">Tipo</p>
        <div className="flex gap-1.5">
          <Chip label="Archivo" active={kind === 'FILE'} onClick={() => setKind('FILE')} />
          <Chip label="Enlace" active={kind === 'LINK'} onClick={() => setKind('LINK')} />
        </div>
      </div>

      {kind === 'FILE' ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text" htmlFor="res-file">
            Archivo (PDF, Word, Excel, ZIP, JSON…)
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
            Enlace
          </label>
          <input
            id="res-link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…"
            className={inputClass}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="res-desc">
          Descripción (opcional)
        </label>
        <textarea
          id="res-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="Qué es y para qué sirve"
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
          Cancelar
        </Button>
        <Button onClick={() => void submit()} disabled={busy}>
          {busy ? 'Compartiendo…' : 'Compartir recurso'}
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
      setError(e instanceof Error ? e.message : 'No pudimos subir la portada.');
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (busy) return;
    setError(null);
    if (title.trim().length < 3) {
      setError('El título necesita al menos 3 caracteres.');
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la colección.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      label="Colección"
      title={existing ? 'Editar colección' : 'Nueva colección'}
      subtitle="Las colecciones agrupan los recursos y tienen su propia portada."
      onClose={onClose}
    >
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="col-title">
          Título
        </label>
        <input
          id="col-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
          placeholder="Workflows de clase"
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="col-desc">
          Descripción
        </label>
        <textarea
          id="col-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="Qué se encuentra dentro"
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text" htmlFor="col-cover">
          Portada
        </label>
        <div
          className="relative grid h-32 place-items-center overflow-hidden rounded-xl border border-border"
          style={{ background: 'linear-gradient(160deg, #0D1B2A 0%, #1E5AA8 100%)' }}
        >
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <p className="text-xs text-white/60">Sin portada: se usa el degradado de marca</p>
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
              Quitar
            </Button>
          ) : null}
        </div>
        {uploading ? <p className="text-xs text-text-subtle">Subiendo portada…</p> : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button onClick={() => void submit()} disabled={busy || uploading}>
          {busy ? 'Guardando…' : existing ? 'Guardar cambios' : 'Crear colección'}
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
