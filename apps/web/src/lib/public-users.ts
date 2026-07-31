'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente de perfil público de usuarios del tenant (mod.community lo usa para
 * pintar avatares en el feed y la página /u/[id]). Backend:
 * `apps/api/src/auth/public-profile.controller.ts`.
 *
 * Avatar/nombre se resuelven por `authorId` (no vienen denormalizados en el
 * post/comentario). Cache en memoria + batch para no disparar N requests en el
 * feed. Best-effort: si falla, el feed cae a iniciales sin romperse.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface PublicUser {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface PublicProfile extends PublicUser {
  bio: string | null;
  jobTitle: string | null;
  department: string | null;
  location: string | null;
  createdAt: string;
}

const cache = new Map<string, PublicUser>();

/** Resuelve (con cache + batch) los datos públicos de varios usuarios por id. */
export async function fetchPublicUsers(ids: string[]): Promise<Map<string, PublicUser>> {
  const unique = [...new Set(ids.filter((id) => id && id.length > 0))];
  const missing = unique.filter((id) => !cache.has(id));
  if (missing.length > 0) {
    const token = authStorage.getAccessToken() ?? undefined;
    try {
      const res = await apiFetch<{ users: PublicUser[] }>(
        `/api/v1/users/public?ids=${encodeURIComponent(missing.join(','))}`,
        { method: 'GET' },
        token,
      );
      for (const u of res.users) cache.set(u.id, u);
    } catch {
      /* best-effort: sin avatares el feed sigue funcionando con iniciales */
    }
  }
  const map = new Map<string, PublicUser>();
  for (const id of unique) {
    const u = cache.get(id);
    if (u) map.set(id, u);
  }
  return map;
}

/** Hook: resuelve avatares/nombres para una lista de authorIds (batch + cache). */
export function usePublicUsers(ids: Array<string | null | undefined>): Map<string, PublicUser> {
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join(',');
  const [map, setMap] = useState<Map<string, PublicUser>>(new Map());
  useEffect(() => {
    const list = key ? key.split(',') : [];
    if (list.length === 0) {
      setMap(new Map());
      return;
    }
    let aborted = false;
    void fetchPublicUsers(list).then((m) => {
      if (!aborted) setMap(m);
    });
    return () => {
      aborted = true;
    };
  }, [key]);
  return map;
}

/** Perfil público completo (para la página /u/[id]). No throws: null si falla. */
export async function fetchPublicProfile(id: string): Promise<PublicProfile | null> {
  const token = authStorage.getAccessToken() ?? undefined;
  try {
    return await apiFetch<PublicProfile>(
      `/api/v1/users/${encodeURIComponent(id)}/public-profile`,
      { method: 'GET' },
      token,
    );
  } catch {
    return null;
  }
}

/** Ruta de la página de perfil público de un usuario. */
export function publicProfileHref(userId: string): string {
  return `/u/${encodeURIComponent(userId)}`;
}
