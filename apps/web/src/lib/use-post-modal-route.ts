'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { usePathname } from 'next/navigation';
import { useRef } from 'react';
import { parsePostPath, postPath } from '@/lib/post-link';

/**
 * Sincroniza el modal de detalle de post con la URL canónica `/comunidad/<id>`.
 *
 * Lo comparten el feed general (`/comunidad`), el deep-link (`/comunidad/[id]`)
 * y los feeds por espacio (`/espacios/[space]`): al abrir un post el navegador
 * muestra una URL única y compartible SIN desmontar el feed (pushState shallow,
 * soportado por el App Router); al cerrar se restaura la URL del feed original.
 *
 * El estado del modal NO se duplica en un useState: se deriva SIEMPRE de
 * `usePathname()`, que Next mantiene sincronizado ante pushState/replaceState
 * shallow, popstate (back/forward) y restores de entradas del historial. Así el
 * modal y la barra de direcciones no pueden divergir: cualquier vía que cambie
 * la URL (botón atrás, un Link del sidebar, un restore tras navegación real)
 * abre o cierra el modal de forma consistente.
 */
export function usePostModalRoute(opts: {
  /** URL a restaurar al cerrar si el modal se abrió por deep-link directo. */
  fallbackPath: string;
}) {
  const pathname = usePathname();
  const selectedPostId = parsePostPath(pathname);
  // URL del feed sobre el que se abrió el modal (con query si la hubiera).
  const feedUrlRef = useRef<string | null>(null);
  // true si la entrada del post la apiló openPost en esta sesión → cerrar debe
  // consumirla con history.back() para no inflar el historial.
  const pushedRef = useRef(false);

  function openPost(id: string) {
    if (typeof window === 'undefined') return;
    if (parsePostPath(window.location.pathname) === null) {
      feedUrlRef.current = window.location.pathname + window.location.search;
      window.history.pushState(null, '', postPath(id));
      pushedRef.current = true;
    } else {
      // Cambiar de post con el modal ya abierto: reemplaza, no apila.
      window.history.replaceState(null, '', postPath(id));
    }
  }

  function closePost() {
    if (typeof window === 'undefined') return;
    // back/forward ya salió de la URL del post: no hay nada que restaurar.
    if (parsePostPath(window.location.pathname) === null) return;
    if (pushedRef.current) {
      pushedRef.current = false;
      // Consume la entrada apilada por openPost; el popstate resultante
      // actualiza usePathname y el modal se cierra derivado de la URL.
      window.history.back();
    } else {
      // Deep-link directo (o entrada restaurada): no apilamos nada, así que
      // reemplazamos la URL por la del feed sin añadir entradas.
      window.history.replaceState(null, '', feedUrlRef.current ?? opts.fallbackPath);
    }
    feedUrlRef.current = null;
  }

  return { selectedPostId, openPost, closePost };
}
