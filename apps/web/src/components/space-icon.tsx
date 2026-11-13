/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Icon, type IconName } from '@/components/icon';
import { COMMUNITY_SPACE_ICONS } from '@/modules/community';

/** Renderiza el icono de un espacio: usa <Icon> si es un nombre de icono válido, o el emoji/texto directamente. */
export function SpaceIcon({
  icon,
  color,
  size = 20,
  className,
}: {
  icon: string;
  color?: string;
  size?: number;
  className?: string;
}) {
  // `#` es el icono con el que nacen los espacios «General» (seed.sql y el
  // alta sencilla): se pinta como el icono de almohadilla, no como texto.
  const name = icon === '#' ? 'hash' : icon;
  if ((COMMUNITY_SPACE_ICONS as readonly string[]).includes(name)) {
    return (
      <Icon
        name={name as IconName}
        size={size}
        className={className}
        style={color ? { color } : undefined}
      />
    );
  }
  return (
    <span className={className} style={{ fontSize: size, lineHeight: 1 }} aria-hidden="true">
      {icon}
    </span>
  );
}

/** Devuelve true si el valor es un nombre de icono predefinido (no emoji). */
export function isIconName(icon: string): icon is IconName {
  return (COMMUNITY_SPACE_ICONS as readonly string[]).includes(icon);
}
