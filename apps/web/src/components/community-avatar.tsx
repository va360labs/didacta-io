'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { publicProfileHref } from '@/lib/public-users';
import { useUserRestriction } from '@/lib/restrictions';
import { RestrictionShield, useCanModerate } from './restriction-shield';
import { displayNameOf, UserAvatar } from './user-chip';

/**
 * Avatar de usuario para la comunidad: muestra la imagen (`avatarUrl`) o, si no
 * hay, las iniciales sobre el gradiente de marca. Si se pasa `userId`, es un
 * enlace al perfil público `/u/[id]` (con stopPropagation para no disparar el
 * onClick de la tarjeta que lo contiene).
 *
 * Delega el pintado en `UserAvatar` para que las iniciales se calculen en un
 * solo sitio del repo. No lleva escudo: en el feed el avatar y el nombre van
 * separados, y el escudo vive junto al NOMBRE (ver `AuthorNameLink`), que es
 * donde se espera encontrarlo y donde no se duplica.
 */
export function CommunityAvatar({
  userId,
  name,
  avatarUrl,
  size = 44,
  linkToProfile = true,
}: {
  userId?: string | null;
  name: string | null | undefined;
  avatarUrl?: string | null;
  size?: number;
  linkToProfile?: boolean;
}) {
  const t = useTranslations('comunidadComponentes');
  // `displayNameOf` es pura y su test aserta el default 'Miembro': el fallback
  // traducido se decide AQUÍ, en el llamante, y se le pasa hecho.
  const box = (
    <UserAvatar name={name} avatarUrl={avatarUrl} size={size} fallback={t('anonymous')} />
  );

  if (userId && linkToProfile) {
    return (
      <Link
        href={publicProfileHref(userId)}
        onClick={(e) => e.stopPropagation()}
        className="block shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        title={name ?? undefined}
      >
        {box}
      </Link>
    );
  }
  return box;
}

/**
 * Nombre del autor como enlace al perfil público, con el escudo de moderación
 * al lado cuando quien mira es admin.
 *
 * El escudo se cuelga aquí y no del avatar porque «al lado del nombre» es
 * donde se busca, y porque así aparece de una vez en el feed, el detalle del
 * post, los comentarios y los espacios sin tocar ninguno de ellos.
 */
export function AuthorNameLink({
  userId,
  name,
  className,
  showShield = true,
}: {
  userId?: string | null;
  name: string | null | undefined;
  className?: string;
  showShield?: boolean;
}) {
  const t = useTranslations('comunidadComponentes');
  const canModerate = useCanModerate(userId);
  const restriction = useUserRestriction(userId, canModerate && showShield);
  const label = displayNameOf(name, null, t('anonymous'));

  if (!userId) return <span className={className}>{label}</span>;

  const link = (
    <Link
      href={publicProfileHref(userId)}
      onClick={(e) => e.stopPropagation()}
      className={className ? `${className} hover:underline` : 'hover:underline'}
    >
      {label}
    </Link>
  );

  if (!showShield || !canModerate) return link;

  return (
    <span className="inline-flex items-center gap-1">
      {link}
      <RestrictionShield userId={userId} userName={label} active={restriction} size={14} />
    </span>
  );
}
