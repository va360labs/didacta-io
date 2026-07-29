'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  ShareResourceModal,
  resourcesApi,
  type CollectionView,
  type ResourceView,
} from '@/modules/resources';

/// Detalle de una colección de recursos: portada, buscador dentro de la
/// colección y tarjetas de recursos. Cualquier miembro comparte; borra el
/// autor (lo suyo) o el staff (todo).

const STAFF_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

export default function ColeccionPage() {
  const params = useParams<{ id: string }>();
  const collectionId = params?.id;

  const [collection, setCollection] = useState<CollectionView | null>(null);
  const [resources, setResources] = useState<ResourceView[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [allCollections, setAllCollections] = useState<CollectionView[] | null>(null);

  const session = useMemo(() => authStorage.getSession(), []);
  const isStaff = useMemo(
    () => (session?.user.roles ?? []).some((r) => STAFF_ROLES.has(r)),
    [session],
  );

  // Nº de petición en vuelo: una respuesta lenta de una búsqueda anterior no
  // puede pisar la de la búsqueda actual (out-of-order).
  const requestSeq = useRef(0);

  const reload = useCallback(
    async (query: string) => {
      if (!collectionId) return;
      const seq = ++requestSeq.current;
      setError(null);
      try {
        const res = await resourcesApi.getCollection(collectionId, query);
        if (seq !== requestSeq.current) return; // llegó tarde: descartada
        setCollection(res.collection);
        setResources(res.resources);
      } catch (e) {
        if (seq !== requestSeq.current) return;
        if (e instanceof ApiHttpError && e.status === 404) setNotFound(true);
        else setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar la colección.');
      }
    },
    [collectionId],
  );

  // Buscador con debounce (300 ms) — server-side, dentro de la colección.
  useEffect(() => {
    const t = setTimeout(() => void reload(q), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, reload]);

  function openResource(r: ResourceView) {
    // La apertura tiene que ser SÍNCRONA dentro del click: tras un await, Safari
    // y los bloqueadores de popups la cancelan (y el contador subiría sin
    // descarga real). La URL ya viene en el listado; el conteo va en segundo
    // plano y es best-effort.
    const a = document.createElement('a');
    a.href = r.url;
    if (r.kind === 'FILE') {
      // `download` fuerza descarga en vez de navegar: un fichero subido jamás
      // se renderiza como página (defensa extra junto al CSP sandbox del API).
      a.download = r.fileName ?? r.title;
    } else {
      a.target = '_blank';
    }
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();

    resourcesApi
      .download(r.id)
      .then(() => reload(q))
      .catch(() => {
        /* el conteo es best-effort: la descarga ya salió */
      });
  }

  async function removeResource(r: ResourceView) {
    if (!window.confirm(`¿Eliminar "${r.title}"? Esta acción no se puede deshacer.`)) return;
    try {
      await resourcesApi.remove(r.id);
      void reload(q);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar el recurso.');
    }
  }

  async function openShare() {
    try {
      setAllCollections(await resourcesApi.listCollections());
      setShareOpen(true);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las colecciones.');
    }
  }

  if (notFound) {
    return (
      <div className="rounded-xl border border-border bg-surface p-12 text-center">
        <p className="text-base font-semibold text-text">Colección no encontrada</p>
        <Button asChild variant="secondary" className="mt-4">
          <Link href={'/recursos' as never}>← Volver a Recursos</Link>
        </Button>
      </div>
    );
  }

  if (!collection) {
    // Con error de primera carga NO se deja un skeleton infinito: se muestra
    // el error con la vuelta atrás.
    if (error) {
      return (
        <div className="space-y-4">
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </div>
          <Button asChild variant="secondary">
            <Link href={'/recursos' as never}>← Volver a Recursos</Link>
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="skeleton h-40 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Link
        href={'/recursos' as never}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text"
      >
        ← Recursos
      </Link>

      {/* Cabecera con la portada de la colección. */}
      <div
        className="relative overflow-hidden rounded-xl"
        style={{ background: 'linear-gradient(160deg, #0D1B2A 0%, #1E5AA8 100%)' }}
      >
        {collection.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={collection.coverUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0D1B2A]/90 via-[#0D1B2A]/35 to-transparent" />
        <div className="relative px-6 pb-5 pt-20">
          <h1 className="font-display text-3xl font-bold text-white">{collection.title}</h1>
          {collection.description ? (
            <p className="mt-1 max-w-2xl text-sm text-white/75">{collection.description}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar en esta colección…"
          className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-border-strong focus:outline-none"
        />
        <Button onClick={() => void openShare()}>
          <Icon name="download-cloud" size={15} />
          Compartir recurso
        </Button>
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
        </div>
      ) : resources.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-12 text-center">
          <p className="text-base font-semibold text-text">
            {q.trim() ? 'Nada por aquí con esa búsqueda' : 'Esta colección llega pronto'}
          </p>
          <p className="mt-1 text-sm text-text-muted">
            {q.trim()
              ? 'Prueba con otras palabras.'
              : 'Sé quien la estrene: comparte el primer recurso.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {resources.map((r) => (
            <ResourceCard
              key={r.id}
              resource={r}
              canDelete={isStaff || r.createdById === session?.user.id}
              onOpen={() => void openResource(r)}
              onRemove={() => void removeResource(r)}
            />
          ))}
        </div>
      )}

      {shareOpen && allCollections ? (
        <ShareResourceModal
          collections={allCollections}
          defaultCollectionId={collection.id}
          onClose={() => setShareOpen(false)}
          onCreated={() => {
            setShareOpen(false);
            void reload(q);
          }}
        />
      ) : null}
    </div>
  );
}

function ResourceCard({
  resource,
  canDelete,
  onOpen,
  onRemove,
}: {
  resource: ResourceView;
  canDelete: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <Card data-testid="resource-card">
      <CardContent className="flex h-full flex-col gap-2.5 p-5">
        <div className="flex items-start justify-between gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-(--didacta-trust)/10 text-(--didacta-trust)">
            <Icon name={resource.kind === 'FILE' ? 'file' : 'link'} size={16} />
          </span>
          {canDelete ? (
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
            <p className="mt-1 truncate text-xs text-text-subtle">{resource.fileName}</p>
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
