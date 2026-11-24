/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/**
 * «Quién puede verlo» de un espacio de la comunidad o de un directo.
 *
 * Por dentro es una lista de grupos de acceso (mod.access-groups); cada nivel
 * de membresía es un grupo con su nombre. Lista vacía = todos los miembros. Las
 * opciones salen de `GET /modules/access-groups/options` (`{ id, name }`), así
 * que lo que se enseña es siempre lo que hay en la base.
 */

export interface AccessLevelOption {
  id: string;
  name: string;
}

/** Lo que elige el creador. «Solo estos niveles» sin ninguno marcado está a medias. */
export type AccessChoice = { mode: 'all' } | { mode: 'levels'; ids: string[] };

/** La elección que corresponde a lo guardado (`[]` = todos). */
export function accessChoiceFrom(ids: readonly string[] | null | undefined): AccessChoice {
  return ids && ids.length > 0 ? { mode: 'levels', ids: [...ids] } : { mode: 'all' };
}

/**
 * Lo que se manda a la API: `[]` para todos, o los niveles marcados que siguen
 * existiendo. `null` si está a medias («Solo estos niveles» sin ninguno válido)
 * y no se puede guardar.
 */
export function accessChoiceToIds(
  choice: AccessChoice,
  options: readonly AccessLevelOption[] | null,
): string[] | null {
  if (choice.mode === 'all') return [];
  const known = options ? new Set(options.map((o) => o.id)) : null;
  const ids = [...new Set(choice.ids)].filter((id) => !known || known.has(id));
  return ids.length > 0 ? ids : null;
}

let cache: AccessLevelOption[] | null = null;
let inflight: Promise<AccessLevelOption[]> | null = null;

async function fetchOptions(): Promise<AccessLevelOption[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const token = authStorage.getAccessToken();
      if (!token) return [];
      const list = await apiFetch<AccessLevelOption[]>(
        '/api/v1/modules/access-groups/options',
        { method: 'GET' },
        token,
      );
      cache = Array.isArray(list) ? list : [];
      return cache;
    } catch {
      // Sin el módulo de grupos activo (403) o sin red: no hay niveles que
      // ofrecer y el campo se queda en «Todos los miembros». No se cachea el
      // fallo, para reintentar en el siguiente montaje.
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Niveles del aula para el campo. `null` mientras cargan. */
export function useAccessLevelOptions(): AccessLevelOption[] | null {
  const [options, setOptions] = useState<AccessLevelOption[] | null>(() => cache);
  useEffect(() => {
    let aborted = false;
    void fetchOptions().then((list) => {
      if (!aborted) setOptions(list);
    });
    return () => {
      aborted = true;
    };
  }, []);
  return options;
}

/** Olvida los niveles cargados (al crear o renombrar un nivel). */
export function invalidateAccessLevelOptions(): void {
  cache = null;
}
