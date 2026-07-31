'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { publicProfileHref } from '@/lib/public-users';
import { useUserRestriction } from '@/lib/restrictions';
import { RestrictionShield, useCanModerate } from './restriction-shield';

/**
 * Forma única de pintar a una persona en Didacta: avatar, nombre, enlace a su
 * ficha y —para admins— el escudo de moderación.
 *
 * Nace para acabar con la dispersión que había: cuatro implementaciones
 * distintas de `initials()` copiadas por el repo y siete fallbacks diferentes
 * para el mismo caso ('Anónimo', 'Miembro', 'Usuario', 'Alumno', 'Sin nombre',
 * el email, y hasta `userId.slice(0, 8)` crudo en la página de grupos).
 *
 * Con el escudo dentro, cualquier sitio que muestre un nombre gana la acción
 * de moderar sin tener que enterarse de que las sanciones existen.
 */

/** Iniciales a partir del nombre. Máximo dos letras. */
export function initialsOf(name: string | null | undefined, fallback = 'A'): string {
  if (!name) return fallback;
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('') || fallback
  );
}

/**
 * Nombre a mostrar, con la cascada acordada: nombre → email → genérico.
 *
 * Nunca devuelve un UUID: un identificador en pantalla no le dice nada a nadie
 * y era lo que se veía en la lista de miembros de un grupo.
 */
export function displayNameOf(
  name: string | null | undefined,
  email?: string | null,
  fallback = 'Miembro',
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const mail = email?.trim();
  if (mail) return mail;
  return fallback;
}

export interface UserChipProps {
  userId?: string | null;
  name: string | null | undefined;
  email?: string | null;
  avatarUrl?: string | null;
  /** Diámetro del avatar en px. */
  size?: number;
  /** Texto cuando no hay ni nombre ni email. */
  fallback?: string;
  showAvatar?: boolean;
  showName?: boolean;
  /** El escudo solo se pinta si además el viewer es admin. */
  showShield?: boolean;
  linkToProfile?: boolean;
  className?: string;
  nameClassName?: string;
  /**
   * Segunda línea bajo el nombre (el email en las tablas de admin, el rol en
   * los listados de miembros). Existe para no tener que desmontar el chip cada
   * vez que hace falta ese patrón, que es el más repetido del panel.
   */
  subtitle?: React.ReactNode;
  subtitleClassName?: string;
  /** Para tarjetas clicables: evita disparar el onClick del contenedor. */
  stopPropagation?: boolean;
}

/** Avatar suelto (imagen o iniciales sobre el gradiente de marca). */
export function UserAvatar({
  name,
  email,
  avatarUrl,
  size = 44,
  fallback = 'Miembro',
}: {
  name: string | null | undefined;
  email?: string | null;
  avatarUrl?: string | null;
  size?: number;
  fallback?: string;
}) {
  const label = displayNameOf(name, email, fallback);
  const dim = { width: `${size}px`, height: `${size}px` };

  return (
    <span className="block shrink-0 overflow-hidden rounded-full" style={dim}>
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt={label} className="h-full w-full object-cover" />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-full w-full place-items-center font-display font-bold text-white"
          style={{
            background: 'linear-gradient(135deg, #1E5AA8 0%, #18B5A8 100%)',
            fontSize: `${Math.round(size * 0.34)}px`,
          }}
        >
          {initialsOf(label)}
        </span>
      )}
    </span>
  );
}

export function UserChip({
  userId,
  name,
  email,
  avatarUrl,
  size = 32,
  fallback = 'Miembro',
  showAvatar = true,
  showName = true,
  showShield = true,
  linkToProfile = true,
  className,
  nameClassName,
  subtitle,
  subtitleClassName,
  stopPropagation = false,
}: UserChipProps) {
  const canModerate = useCanModerate(userId);
  // El hook agrupa las peticiones de toda la pantalla en una sola llamada.
  const restriction = useUserRestriction(userId, canModerate && showShield);

  const label = displayNameOf(name, email, fallback);
  const stop = stopPropagation ? (e: React.MouseEvent) => e.stopPropagation() : undefined;

  const avatar = showAvatar ? (
    <UserAvatar name={name} email={email} avatarUrl={avatarUrl} size={size} fallback={fallback} />
  ) : null;

  const text =
    showName || subtitle ? (
      <span className="block min-w-0">
        {showName ? <span className={nameClassName ?? 'block truncate'}>{label}</span> : null}
        {subtitle ? (
          <span className={subtitleClassName ?? 'block truncate text-xs text-text-subtle'}>
            {subtitle}
          </span>
        ) : null}
      </span>
    ) : null;

  const body =
    userId && linkToProfile ? (
      <Link
        href={publicProfileHref(userId)}
        onClick={stop}
        title={label}
        className="flex min-w-0 items-center gap-2 rounded-md hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {avatar}
        {text}
      </Link>
    ) : (
      <span className="flex min-w-0 items-center gap-2" title={label}>
        {avatar}
        {text}
      </span>
    );

  return (
    <span className={['inline-flex min-w-0 items-center gap-1', className ?? ''].join(' ')}>
      {body}
      {showShield && canModerate && userId ? (
        <RestrictionShield
          userId={userId}
          userName={label}
          active={restriction}
          size={Math.max(14, Math.round(size * 0.42))}
        />
      ) : null}
    </span>
  );
}
