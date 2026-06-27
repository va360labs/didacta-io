'use client';

import Link from 'next/link';
import { publicProfileHref } from '@/lib/public-users';

function initialsOf(name: string | null | undefined): string {
  if (!name) return 'A';
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('') || 'A'
  );
}

/**
 * Avatar de usuario para la comunidad: muestra la imagen (`avatarUrl`) o, si no
 * hay, las iniciales sobre el gradiente de marca. Si se pasa `userId`, es un
 * enlace al perfil público `/u/[id]` (con stopPropagation para no disparar el
 * onClick de la tarjeta que lo contiene).
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
  const dim = { width: `${size}px`, height: `${size}px` };
  const inner = avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={avatarUrl} alt={name ?? 'Avatar'} className="h-full w-full object-cover" />
  ) : (
    <span
      aria-hidden="true"
      className="grid h-full w-full place-items-center font-display font-bold text-white"
      style={{
        background: 'linear-gradient(135deg, #1E5AA8 0%, #18B5A8 100%)',
        fontSize: `${Math.round(size * 0.34)}px`,
      }}
    >
      {initialsOf(name)}
    </span>
  );

  const box = (
    <span className="block shrink-0 overflow-hidden rounded-full" style={dim}>
      {inner}
    </span>
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

/** Nombre del autor como enlace al perfil público (stopPropagation para tarjetas). */
export function AuthorNameLink({
  userId,
  name,
  className,
}: {
  userId?: string | null;
  name: string | null | undefined;
  className?: string;
}) {
  const label = name ?? 'Anónimo';
  if (!userId) return <span className={className}>{label}</span>;
  return (
    <Link
      href={publicProfileHref(userId)}
      onClick={(e) => e.stopPropagation()}
      className={className ? `${className} hover:underline` : 'hover:underline'}
    >
      {label}
    </Link>
  );
}
