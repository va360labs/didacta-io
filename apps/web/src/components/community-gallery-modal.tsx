'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useState } from 'react';
import { relTime } from '@/components/community-thread-card';
import { Icon } from '@/components/icon';
import { ImageLightbox } from '@/components/image-lightbox';
import { Dialog } from '@/components/ui/dialog';
import { ApiHttpError } from '@/lib/api-client';
import {
  communityApi,
  filterGalleryAttachments,
  galleryAuthorOptions,
  type AttachmentImage,
  type CommunityAttachment,
  type GalleryFilters,
  type GalleryType,
} from '@/modules/community';

const PAGE_SIZE = 60;

const TYPE_TABS: Array<{ value: GalleryType; label: string }> = [
  { value: 'all', label: 'Todo' },
  { value: 'image', label: 'Imágenes' },
  { value: 'file', label: 'Archivos' },
];

const SELECT_CLASS =
  'rounded-md border border-border bg-surface px-2 py-1.5 text-xs font-medium text-text focus:outline-none focus:ring-2 focus:ring-brand-500';

interface InternalFilters extends GalleryFilters {
  from: string;
  to: string;
}

const INITIAL_FILTERS: InternalFilters = {
  type: 'all',
  sort: 'recent',
  authorId: 'all',
  search: '',
  from: '',
  to: '',
};

export function CommunityGalleryModal({
  open,
  onClose,
  tag,
  title,
}: {
  open: boolean;
  onClose: () => void;
  /** Slug del espacio; omitido = galería global (todos los espacios). */
  tag?: string;
  title: string;
}) {
  const [items, setItems] = useState<CommunityAttachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<InternalFilters>(INITIAL_FILTERS);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [lightbox, setLightbox] = useState<{ images: AttachmentImage[]; idx: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setItems(null);
    setError(null);
    setFilters(INITIAL_FILTERS);
    setVisible(PAGE_SIZE);
    communityApi
      .listAttachments({ tag })
      .then((data) => {
        if (alive) setItems(data);
      })
      .catch((e) => {
        if (alive)
          setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar la galería.');
      });
    return () => {
      alive = false;
    };
  }, [open, tag]);

  const authors = useMemo(() => galleryAuthorOptions(items ?? []), [items]);
  const filtered = useMemo(() => filterGalleryAttachments(items ?? [], filters), [items, filters]);

  function patch(p: Partial<InternalFilters>) {
    setFilters((f) => ({ ...f, ...p }));
    setVisible(PAGE_SIZE);
  }

  function openImage(clicked: CommunityAttachment) {
    const imgs = filtered.filter((a) => a.kind === 'image');
    const idx = Math.max(
      0,
      imgs.findIndex((a) => a.url === clicked.url && a.postId === clicked.postId),
    );
    setLightbox({ images: imgs.map((a) => ({ url: a.url, name: a.name })), idx });
  }

  const shown = filtered.slice(0, visible);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      ariaLabel={title}
      maxWidthClass="max-w-5xl"
      contentClassName="p-6 sm:p-7"
    >
      <div className="flex items-center gap-2">
        <Icon name="image" size={20} className="text-brand-600" />
        <h2 className="font-display text-xl font-bold tracking-tight text-text">{title}</h2>
      </div>

      {/* Filtros */}
      <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
          {TYPE_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => patch({ type: t.value })}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                filters.type === t.value
                  ? 'bg-brand-500 text-text-on-brand'
                  : 'text-text-muted hover:text-text'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1 text-[11px] font-medium text-text-subtle">
          Buscar
          <input
            type="search"
            value={filters.search}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="Nombre del archivo…"
            className={SELECT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] font-medium text-text-subtle">
          Autor
          <select
            value={filters.authorId}
            onChange={(e) => patch({ authorId: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="all">Todos</option>
            {authors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] font-medium text-text-subtle">
          Desde
          <input
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => patch({ from: e.target.value })}
            className={SELECT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] font-medium text-text-subtle">
          Hasta
          <input
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => patch({ to: e.target.value })}
            className={SELECT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] font-medium text-text-subtle">
          Orden
          <select
            value={filters.sort}
            onChange={(e) => patch({ sort: e.target.value as GalleryFilters['sort'] })}
            className={SELECT_CLASS}
          >
            <option value="recent">Más recientes</option>
            <option value="oldest">Más antiguos</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() => {
            setFilters(INITIAL_FILTERS);
            setVisible(PAGE_SIZE);
          }}
          className="ml-auto text-xs font-medium text-brand-700 hover:underline"
        >
          Limpiar filtros
        </button>
      </div>

      <div className="mt-3 h-px bg-[#F1F5F9]" />

      {/* Contenido */}
      <div className="mt-4">
        {error ? (
          <div className="rounded-lg bg-danger-50 p-4 text-sm text-danger-700">{error}</div>
        ) : items === null ? (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="skeleton h-20 w-20 rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-text-muted">
            {items.length === 0
              ? 'Todavía no hay imágenes ni archivos en este espacio.'
              : 'Ningún adjunto coincide con los filtros.'}
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-text-subtle">
              {filtered.length} {filtered.length === 1 ? 'adjunto' : 'adjuntos'}
            </p>
            <div className="flex flex-wrap gap-2">
              {shown.map((a, i) => {
                const tip = `${a.name}\n${a.authorName ?? 'Anónimo'} · ${relTime(a.createdAt)}`;
                return a.kind === 'image' ? (
                  <button
                    key={`${a.postId}-${i}`}
                    type="button"
                    title={tip}
                    onClick={() => openImage(a)}
                    className="relative h-20 w-20 overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] focus:outline-none focus:ring-2 focus:ring-[#1E5AA8]"
                  >
                    <img
                      src={a.url}
                      alt={a.name}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-200 hover:scale-105"
                    />
                  </button>
                ) : (
                  <a
                    key={`${a.postId}-${i}`}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={tip}
                    className="grid h-20 w-20 place-items-center rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B] transition-colors hover:bg-[#F1F5F9]"
                  >
                    <Icon name="file" size={28} />
                  </a>
                );
              })}
            </div>
            {visible < filtered.length ? (
              <div className="mt-5 flex justify-center">
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="rounded-lg border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-2"
                >
                  Cargar más
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {lightbox ? (
        <ImageLightbox
          images={lightbox.images}
          initialIdx={lightbox.idx}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </Dialog>
  );
}
