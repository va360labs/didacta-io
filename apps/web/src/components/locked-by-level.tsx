'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';

interface Props {
  /** Espacio de la comunidad o clase en directo: cambia la frase. */
  kind: 'space' | 'live';
  /** Nombre del espacio o título de la clase (lo único que se enseña). */
  title: string;
  /** Niveles con los que se abre; vacío si ya no queda ninguno vivo. */
  levels: ReadonlyArray<{ id: string; name: string }>;
  /** Línea extra bajo el título (la hora de la clase, por ejemplo). */
  meta?: string;
  /** `panel`: ocupa la página; `inline`: dentro de una tarjeta. */
  variant?: 'panel' | 'inline';
}

/**
 * Lo que ve quien no tiene el nivel: el nombre, el candado, en qué niveles
 * está disponible y el botón a `/join` para subir de nivel. Nunca el contenido,
 * la descripción, el enlace ni la grabación (la API ni siquiera los manda).
 */
export function LockedByLevel({ kind, title, levels, meta, variant = 'panel' }: Props) {
  const t = useTranslations('comunidadComponentes.nivelAcceso');
  const panel = variant === 'panel';
  return (
    <div
      data-testid={`bloqueado-${kind}`}
      className={cn(
        'flex flex-col items-center text-center',
        panel ? 'rounded-2xl border border-border bg-surface px-6 py-10' : 'gap-1 py-2',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid place-items-center rounded-full bg-brand-50 text-brand-700',
          panel ? 'h-12 w-12' : 'h-9 w-9',
        )}
      >
        <Icon name="lock" size={panel ? 22 : 17} />
      </span>
      <h2 className={cn('font-bold text-text', panel ? 'mt-4 text-lg' : 'mt-2 text-base')}>
        {title}
      </h2>
      {meta ? <p className="mt-1 text-sm text-text-subtle">{meta}</p> : null}
      <p className={cn('max-w-[52ch] text-text-muted', panel ? 'mt-2' : 'mt-1 text-sm')}>
        {kind === 'space' ? t('candadoEspacio') : t('candadoClase')}
      </p>
      <p className="mt-1 text-sm font-semibold text-text" data-testid="disponible-en">
        {levels.length > 0
          ? t('disponibleEn', { niveles: levels.map((l) => l.name).join(', ') })
          : t('disponibleEnOtros')}
      </p>
      <Link
        href="/join"
        className={cn(
          'inline-flex items-center gap-2 rounded-xl bg-brand-600 font-semibold text-white hover:bg-brand-700',
          panel ? 'mt-5 h-11 px-5' : 'mt-3 h-9 px-4 text-sm',
        )}
      >
        {t('verPlanes')}
      </Link>
    </div>
  );
}

/**
 * Marca para el equipo en las listas de su panel: este espacio o esta clase no
 * la ve todo el mundo. `null` si está abierta a todos.
 */
export function AccessLevelsBadge({
  groupIds,
  levels,
}: {
  groupIds: readonly string[] | undefined;
  levels: ReadonlyArray<{ id: string; name: string }> | undefined;
}) {
  const t = useTranslations('comunidadComponentes.nivelAcceso');
  if (!groupIds || groupIds.length === 0) return null;
  const names = (levels ?? []).map((l) => l.name);
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium text-brand-700"
      data-testid="con-nivel"
    >
      <Icon name="lock" size={12} />
      {names.length > 0 ? t('soloPara', { niveles: names.join(', ') }) : t('soloAlgunos')}
    </span>
  );
}
