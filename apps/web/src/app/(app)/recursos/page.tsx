'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  CollectionFormModal,
  ShareResourceModal,
  resourcesApi,
  type CollectionView,
} from '@/modules/resources';

/// Biblioteca de recursos (bloque 4): parrilla de COLECCIONES con portada
/// ("Workflows de clase", "Skills y agentes"…). Cualquier miembro comparte
/// recursos; el staff crea y edita colecciones.

const STAFF_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

export default function RecursosPage() {
  const t = useTranslations('alumnoAprendizaje');
  const tErrors = useTranslations('errors');
  const [collections, setCollections] = useState<CollectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editing, setEditing] = useState<CollectionView | null | 'new'>(null);

  const isStaff = useMemo(() => {
    const roles = authStorage.getSession()?.user.roles ?? [];
    return roles.some((r) => STAFF_ROLES.has(r));
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setCollections(await resourcesApi.listCollections());
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('resourcesLoadError'));
    }
    // Deps vacías a propósito: `reload` no debe cambiar de identidad (la
    // dispara un efecto) y `t`/`tErrors` solo componen el mensaje de error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">{t('resourcesTitle')}</h1>
          <p className="mt-1 text-sm text-text-muted">
            {collections
              ? t('collectionsSummary', { count: collections.length })
              : t('resourcesSubtitle')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isStaff ? (
            <Button variant="secondary" onClick={() => setEditing('new')}>
              {t('newCollection')}
            </Button>
          ) : null}
          <Button onClick={() => setShareOpen(true)}>
            <Icon name="download-cloud" size={15} />
            {t('shareResource')}
          </Button>
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

      {collections === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="skeleton h-80 w-full" />
          <div className="skeleton h-80 w-full" />
          <div className="skeleton h-80 w-full" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              isStaff={isStaff}
              onEdit={() => setEditing(c)}
            />
          ))}
        </div>
      )}

      {shareOpen && collections ? (
        <ShareResourceModal
          collections={collections}
          onClose={() => setShareOpen(false)}
          onCreated={() => {
            setShareOpen(false);
            void reload();
          }}
        />
      ) : null}

      {editing ? (
        <CollectionFormModal
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CollectionCard({
  collection,
  isStaff,
  onEdit,
}: {
  collection: CollectionView;
  isStaff: boolean;
  onEdit: () => void;
}) {
  const t = useTranslations('alumnoAprendizaje');
  return (
    <Card data-testid="collection-card" className="overflow-hidden">
      {/* Portada: imagen propia o degradado de marca. El título va bajo la imagen. */}
      <div
        className="relative h-44"
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
        {isStaff ? (
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('editCollectionAria', { title: collection.title })}
            title={t('editCollection')}
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg bg-white/15 text-white/80 backdrop-blur transition-colors hover:bg-white/25 hover:text-white"
          >
            <Icon name="edit" size={14} />
          </button>
        ) : null}
      </div>

      <CardContent className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <p className="min-w-0 truncate font-semibold text-text">{collection.title}</p>
          {collection.resourceCount > 0 ? (
            <Badge variant="info">{t('resourceCount', { count: collection.resourceCount })}</Badge>
          ) : (
            <Badge variant="success">{t('comingSoon')}</Badge>
          )}
        </div>
        {collection.description ? (
          <p className="line-clamp-2 text-sm text-text-muted">{collection.description}</p>
        ) : null}
        <Button asChild>
          <Link href={`/recursos/${collection.id}` as never}>
            <Icon name="link" size={14} />
            {t('explore')}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
