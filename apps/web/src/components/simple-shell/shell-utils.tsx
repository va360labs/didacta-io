'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect } from 'react';

/** Contador rojo sobre un icono de la cabecera. */
export function Counter({ n }: { n: number }) {
  return (
    <span className="absolute top-1 right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-surface bg-red-600 px-1 text-[10px] font-bold text-white tabular-nums">
      {n > 99 ? '99+' : n}
    </span>
  );
}

/** Cierra un desplegable al pulsar fuera o con Escape. */
export function useOutsideClose(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose]);
}

/**
 * Iniciales del avatar: dos del nombre («Marta Ríos» → «MR») o, sin nombre, la
 * inicial del correo. Cadena vacía si no hay ninguna (el avatar pone un icono).
 */
export function avatarInitials(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const fromName = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toLocaleUpperCase() ?? '')
    .join('');
  if (fromName) return fromName;
  const first = [...(email ?? '').trim()][0];
  return first && /\p{L}|\p{N}/u.test(first) ? first.toLocaleUpperCase() : '';
}
