'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { uploadCommunityFile } from '@/lib/community-upload';
import {
  RESOURCE_CATEGORY_LABELS,
  resourcesApi,
  type CreateResourceInput,
  type ResourceCategory,
  type ResourceView,
} from '@/modules/resources';

/// Biblioteca de recursos (bloque 4): workflows de las clases, skills,
/// directorio de herramientas y plantillas. Categorías fijas + buscador.
/// Cualquier miembro consulta y descarga; admin/formador publican.

const STAFF_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);
const CATEGORIES = Object.keys(RESOURCE_CATEGORY_LABELS) as ResourceCategory[];

export default function RecursosPage() {
  const [resources, setResources] = useState<ResourceView[] | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<ResourceCategory | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const isStaff = useMemo(() => {
    const roles = authStorage.getSession()?.user.roles ?? [];
    return roles.some((r) => STAFF_ROLES.has(r));
  }, []);

  const reload = useCallback(async (filter: { category?: ResourceCategory; q?: string }) => {
    setError(null);
    try {
      setResources(await resourcesApi.list(filter));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los recursos.');
    }
  }, []);

  // Buscador con debounce (300 ms) — la búsqueda es server-side.
  useEffect(() => {
    const t = setTimeout(() => {
      void reload({ ...(category ? { category } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
    }, 300);
    return () => clearTimeout(t);
  }, [q, category, reload]);

  async function openResource(r: ResourceView) {
    try {
      const { url } = await resourcesApi.download(r.id);
      window.open(url, '_blank', 'noopener');
      // Refresco silencioso para que el contador se vea al día.
      void reload({ ...(category ? { category } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos abrir el recurso.');
    }
  }

  async function removeResource(r: ResourceView) {
    if (!window.confirm(`¿Eliminar "${r.title}"? Esta acción no se puede deshacer.`)) return;
    try {
      await resourcesApi.remove(r.id);
      void reload({ ...(category ? { category } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar el recurso.');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">Recursos</h1>
          <p className="mt-1 text-sm text-text-muted">
            Workflows de las clases, skills, herramientas y plantillas — todo en un sitio, listo
            para descargar.
          </p>
        </div>
        {isStaff ? (
          <Button onClick={() => setModalOpen(true)}>
            <Icon name="download-cloud" size={15} />
            Añadir recurso
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar recursos…"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-3 pr-3 text-sm text-text placeholder:text-text-subtle focus:border-border-strong focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <CategoryChip label="Todos" active={category === ''} onClick={() => setCategory('')} />
          {CATEGORIES.map((c) => (
            <CategoryChip
              key={c}
              label={RESOURCE_CATEGORY_LABELS[c]}
              active={category === c}
              onClick={() => setCategory(c)}
            />
          ))}
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

      {resources === null ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="skeleton h-36 w-full" />
          <div className="skeleton h-36 w-full" />
          <div className="skeleton h-36 w-full" />
        </div>
      ) : resources.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-12 text-center">
          <p className="text-base font-semibold text-text">
            {q.trim() || category ? 'Nada por aquí con ese filtro' : 'Aún no hay recursos'}
          </p>
          <p className="mt-1 text-sm text-text-muted">
            {q.trim() || category
              ? 'Prueba con otra búsqueda u otra categoría.'
              : 'Cada clase en directo irá dejando aquí su workflow, plantilla o herramienta.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {resources.map((r) => (
            <ResourceCard
              key={r.id}
              resource={r}
              isStaff={isStaff}
              onOpen={() => void openResource(r)}
              onRemove={() => void removeResource(r)}
            />
          ))}
        </div>
      )}

      {modalOpen ? (
        <NewResourceModal
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            void reload({
              ...(category ? { category } : {}),
              ...(q.trim() ? { q: q.trim() } : {}),
            });
          }}
        />
      ) : null}
    </div>
  );
}

function CategoryChip({
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

function ResourceCard({
  resource,
  isStaff,
  onOpen,
  onRemove,
}: {
  resource: ResourceView;
  isStaff: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <Card data-testid="resource-card">
      <CardContent className="flex h-full flex-col gap-2.5 p-5">
        <div className="flex items-start justify-between gap-2">
          <Badge variant="info">{RESOURCE_CATEGORY_LABELS[resource.category]}</Badge>
          {isStaff ? (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Eliminar ${resource.title}`}
              title="Eliminar"
              className="grid h-6 w-6 place-items-center rounded-md text-text-subtle transition-colors hover:bg-danger-50 hover:text-danger-700"
            >
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug text-text">{resource.title}</p>
          {resource.description ? (
            <p className="mt-1 line-clamp-2 text-sm text-text-muted">{resource.description}</p>
          ) : null}
          {resource.fileName ? (
            <p className="mt-1 truncate text-xs text-text-subtle">
              <Icon name="file" size={11} className="mr-1 inline-block" />
              {resource.fileName}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-text-subtle">
            {resource.downloadCount} descarga{resource.downloadCount !== 1 ? 's' : ''}
          </p>
          <Button size="sm" variant="secondary" onClick={onOpen}>
            <Icon name={resource.kind === 'FILE' ? 'download-cloud' : 'link'} size={13} />
            {resource.kind === 'FILE' ? 'Descargar' : 'Abrir'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NewResourceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<ResourceCategory>('WORKFLOW');
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
          category,
          kind,
          title: title.trim(),
          description: description.trim() || undefined,
          url: uploaded.url,
          fileName: uploaded.name,
        };
      } else {
        input = {
          category,
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
          : 'No pudimos publicar el recurso.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-(--z-overlay) grid place-items-center bg-[#0d1b2a]/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Nuevo recurso"
    >
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-text">Nuevo recurso</h2>
              <p className="mt-0.5 text-xs text-text-muted">
                Un workflow de la clase, una skill, una herramienta o una plantilla.
              </p>
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
              className="w-full rounded-lg border border-border bg-surface p-2.5 text-sm text-text placeholder:text-text-subtle focus:border-border-strong focus:outline-none"
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-sm font-medium text-text">Categoría</p>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <CategoryChip
                  key={c}
                  label={RESOURCE_CATEGORY_LABELS[c]}
                  active={category === c}
                  onClick={() => setCategory(c)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-sm font-medium text-text">Tipo</p>
            <div className="flex gap-1.5">
              <CategoryChip
                label="Archivo"
                active={kind === 'FILE'}
                onClick={() => setKind('FILE')}
              />
              <CategoryChip
                label="Enlace"
                active={kind === 'LINK'}
                onClick={() => setKind('LINK')}
              />
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
                className="w-full rounded-lg border border-border bg-surface p-2.5 text-sm text-text placeholder:text-text-subtle focus:border-border-strong focus:outline-none"
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
              className="w-full rounded-lg border border-border bg-surface p-2.5 text-sm text-text placeholder:text-text-subtle focus:border-border-strong focus:outline-none"
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
              {busy ? 'Publicando…' : 'Publicar recurso'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
