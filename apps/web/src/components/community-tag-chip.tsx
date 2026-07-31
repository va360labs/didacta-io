'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Icon, type IconName } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { CommunityTag } from '@/modules/community';

interface CommunityTagChipProps {
  name: string;
  tag: CommunityTag | undefined;
  /** Si está set, el chip es interactivo (ej. filtro del feed). */
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}

/**
 * Chip de tag de comunidad. Si el tenant tiene un tag curado con ese
 * nombre, lo pinta con su color/icono; si no, cae al `<Badge variant="info">`
 * por defecto. Preserva compatibilidad con tags libres sin curar.
 */
export function CommunityTagChip({ name, tag, onClick, className }: CommunityTagChipProps) {
  // Sin tag curado → Badge info por defecto.
  if (!tag) {
    if (onClick) {
      return (
        <button type="button" onClick={onClick} className={cn('rounded-full', className)}>
          <Badge variant="info" className="cursor-pointer hover:opacity-80">
            {name}
          </Badge>
        </button>
      );
    }
    return (
      <Badge variant="info" className={className}>
        {name}
      </Badge>
    );
  }

  // Con tag curado: 18% de alpha sobre el color del tenant para el fondo,
  // borde a 25% y texto al color sólido. Da contraste razonable en light
  // y dark sin necesidad de lookup contra la paleta.
  const styles = {
    backgroundColor: `${tag.color}2E`,
    color: tag.color,
    borderColor: `${tag.color}40`,
  } as const;

  const Element: 'button' | 'span' = onClick ? 'button' : 'span';

  return (
    <Element
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        onClick && 'cursor-pointer transition-opacity hover:opacity-80',
        className,
      )}
      style={styles}
    >
      {tag.icon ? <Icon name={tag.icon as IconName} size={12} /> : null}
      <span>{tag.name}</span>
    </Element>
  );
}
