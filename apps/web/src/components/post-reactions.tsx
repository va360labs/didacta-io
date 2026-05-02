'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { Reaction } from '@/modules/community';

/**
 * Cuatro emojis fijos. Si en el futuro se vuelve configurable por tenant,
 * mover a `mod_community_settings` y pasar como prop.
 */
export const COMMUNITY_EMOJIS = ['👍', '❤️', '🎉', '🤔'] as const;
export type CommunityEmoji = (typeof COMMUNITY_EMOJIS)[number];

interface PostReactionsProps {
  reactions: Reaction[] | undefined;
  /** UUID del usuario actual para resaltar las reacciones que ya hizo. */
  viewerUserId: string | null;
  /** Si se provee, los chips son interactivos. Si no, son solo display. */
  onToggle?: (emoji: string) => void;
  pending?: boolean;
  /** Estilo: 'compact' para listado, 'full' para detalle del post. */
  variant?: 'compact' | 'full';
}

/**
 * Renderiza los chips de reacciones de un post. Reusable en el listado
 * (variant='compact') y en el detalle (variant='full', con onToggle).
 *
 * El payload `reactions` es la lista cruda devuelta por el backend; se
 * agrega por emoji acá para evitar pre-procesarlo en el server.
 */
export function PostReactions({
  reactions,
  viewerUserId,
  onToggle,
  pending,
  variant = 'compact',
}: PostReactionsProps): React.JSX.Element | null {
  const aggregated = useMemo(() => {
    const counts: Record<string, { count: number; mine: boolean }> = {};
    for (const e of COMMUNITY_EMOJIS) counts[e] = { count: 0, mine: false };
    for (const r of reactions ?? []) {
      const cur = counts[r.emoji];
      if (!cur) continue;
      cur.count++;
      if (viewerUserId && r.authorId === viewerUserId) cur.mine = true;
    }
    return counts;
  }, [reactions, viewerUserId]);

  // En variant compact:
  //  - Si es interactivo (hay onToggle), mostramos los 4 emojis para que el
  //    viewer pueda reaccionar al post sin tener que abrir el detalle.
  //  - Si es solo display (sin onToggle), filtramos a los que ya tienen al
  //    menos una reacción para no saturar la card con chips vacíos.
  const visibleEmojis =
    variant === 'compact' && !onToggle
      ? COMMUNITY_EMOJIS.filter((e) => (aggregated[e]?.count ?? 0) > 0)
      : COMMUNITY_EMOJIS;

  if (visibleEmojis.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', variant === 'full' && 'gap-2')}>
      {visibleEmojis.map((e) => {
        const { count, mine } = aggregated[e]!;
        const interactive = !!onToggle;
        const Element = interactive ? 'button' : ('span' as const);
        return (
          <Element
            key={e}
            type={interactive ? 'button' : undefined}
            disabled={interactive ? pending : undefined}
            onClick={
              interactive
                ? (ev: React.MouseEvent) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    onToggle(e);
                  }
                : undefined
            }
            className={cn(
              'inline-flex items-center gap-1 rounded-full border text-sm transition-colors',
              variant === 'compact' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1',
              mine
                ? 'border-[rgba(46,125,206,0.32)] bg-[var(--didacta-info-bg)] text-[var(--didacta-info-fg)]'
                : 'border-border bg-surface text-text-muted',
              interactive && 'hover:border-border-strong hover:text-text',
            )}
          >
            <span>{e}</span>
            {count > 0 ? <span className="tabular-nums">{count}</span> : null}
          </Element>
        );
      })}
    </div>
  );
}
