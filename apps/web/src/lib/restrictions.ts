'use client';

/**
 * Cliente de sanciones de moderación. Backend:
 * `apps/api/src/moderation/restriction.controller.ts`.
 *
 * Una sanción NO impide entrar ni leer: impide aportar contenido en las áreas
 * indicadas. Cortar el acceso entero sigue siendo `PATCH /admin/users/:id/status`.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';

/** Mismas claves que `restriction-scopes.ts` en la API. */
export const RESTRICTION_SCOPES = [
  { value: 'community', label: 'Comunidad', hint: 'Publicar, comentar y reaccionar' },
  { value: 'messaging', label: 'Mensajes', hint: 'Escribir en chats y abrir conversaciones' },
  { value: 'uploads', label: 'Subidas de archivos', hint: 'Subir imágenes y recursos' },
  { value: 'ai', label: 'Tutor IA', hint: 'Hacer preguntas al tutor' },
] as const;

export const SCOPE_ALL = 'all';

/** Duraciones del diálogo. `null` = permanente. */
export const RESTRICTION_DURATIONS = [
  { value: '24h', label: '24 horas', hours: 24 },
  { value: '7d', label: '7 días', hours: 24 * 7 },
  { value: '30d', label: '30 días', hours: 24 * 30 },
  { value: 'permanent', label: 'Permanente', hours: null },
] as const;

export type DurationValue = (typeof RESTRICTION_DURATIONS)[number]['value'];

export interface Restriction {
  id: string;
  userId: string;
  scopes: string[];
  scopeLabels: string[];
  reason: string;
  expiresAt: string | null;
  createdAt: string;
  createdById: string;
  createdByName: string | null;
  liftedAt: string | null;
  liftedById: string | null;
  liftedByName: string | null;
  liftReason: string | null;
  active: boolean;
}

function token(): string | undefined {
  return authStorage.getAccessToken() ?? undefined;
}

function base(userId: string): string {
  return `/api/v1/admin/users/${encodeURIComponent(userId)}/restrictions`;
}

export const restrictionsApi = {
  /** Histórico completo (activas, caducadas y levantadas). */
  list(userId: string): Promise<Restriction[]> {
    return apiFetch<Restriction[]>(base(userId), { method: 'GET' }, token());
  },

  create(
    userId: string,
    input: { scopes: string[]; reason: string; expiresAt: string | null },
  ): Promise<Restriction> {
    return apiFetch<Restriction>(
      base(userId),
      { method: 'POST', body: JSON.stringify(input) },
      token(),
    );
  },

  lift(userId: string, restrictionId: string, liftReason: string | null): Promise<Restriction> {
    return apiFetch<Restriction>(
      `${base(userId)}/${encodeURIComponent(restrictionId)}/lift`,
      { method: 'POST', body: JSON.stringify({ liftReason }) },
      token(),
    );
  },
};

/** Resumen de la sanción vigente de un usuario, para el estado del escudo. */
export interface ActiveRestrictionSummary {
  scopes: string[];
  scopeLabels: string[];
  expiresAt: string | null;
}

/**
 * Caché de sanciones vigentes por usuario.
 *
 * El escudo se pinta al lado de CADA nombre; sin caché ni batch, un feed con
 * 20 posts dispararía 20 peticiones. Mismo patrón que `fetchPublicUsers`.
 */
const activeCache = new Map<string, ActiveRestrictionSummary | null>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Fuerza el refresco tras sancionar o levantar, para que el escudo cambie ya. */
export function invalidateRestrictionCache(userId?: string): void {
  if (userId) activeCache.delete(userId);
  else activeCache.clear();
  notify();
}

async function fetchActiveRestrictions(
  ids: string[],
): Promise<Map<string, ActiveRestrictionSummary | null>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const missing = unique.filter((id) => !activeCache.has(id));
  if (missing.length > 0) {
    try {
      const res = await apiFetch<Record<string, ActiveRestrictionSummary>>(
        `/api/v1/admin/restrictions/active?userIds=${encodeURIComponent(missing.join(','))}`,
        { method: 'GET' },
        token(),
      );
      // Los que no vuelven es que no tienen sanción: se cachean como null para
      // no volver a preguntar por ellos en cada render.
      for (const id of missing) activeCache.set(id, res[id] ?? null);
    } catch {
      /* best-effort: sin esto el escudo sale gris, que es el estado neutro */
    }
  }
  const map = new Map<string, ActiveRestrictionSummary | null>();
  for (const id of unique) map.set(id, activeCache.get(id) ?? null);
  return map;
}

/**
 * Agrupador al estilo DataLoader.
 *
 * El escudo se pinta junto a CADA nombre, así que si cada componente pidiera
 * su propio id tendríamos una petición por autor aunque hubiese caché. Esto
 * acumula los ids pedidos dentro del mismo tick y dispara una sola llamada.
 *
 * Es lo que permite que `<UserChip>` sea drop-in en los ~30 sitios sin que
 * cada página tenga que recolectar los ids y pasarlos hacia abajo.
 */
let pendingIds = new Set<string>();
let pendingFlush: Promise<void> | null = null;

function scheduleActiveFetch(id: string): Promise<ActiveRestrictionSummary | null> {
  if (activeCache.has(id)) return Promise.resolve(activeCache.get(id) ?? null);

  pendingIds.add(id);
  pendingFlush ??= new Promise<void>((resolve) => {
    setTimeout(() => {
      const ids = [...pendingIds];
      pendingIds = new Set();
      pendingFlush = null;
      void fetchActiveRestrictions(ids).then(() => resolve());
    }, 0);
  });

  return pendingFlush.then(() => activeCache.get(id) ?? null);
}

/**
 * Hook: sanción vigente de UN usuario, agrupada con las del resto de la
 * pantalla. Es el que usa `<UserChip>`.
 *
 * Solo consulta si `enabled` — el endpoint es admin-only, así que para un
 * miembro normal no tiene sentido ni pedirlo.
 */
export function useUserRestriction(
  userId: string | null | undefined,
  enabled: boolean,
): ActiveRestrictionSummary | null {
  const [value, setValue] = useState<ActiveRestrictionSummary | null>(null);

  const load = useCallback(() => {
    if (!enabled || !userId) {
      setValue(null);
      return;
    }
    let aborted = false;
    void scheduleActiveFetch(userId).then((v) => {
      if (!aborted) setValue(v);
    });
    return () => {
      aborted = true;
    };
  }, [userId, enabled]);

  useEffect(() => {
    const cleanup = load();
    listeners.add(load);
    return () => {
      listeners.delete(load);
      cleanup?.();
    };
  }, [load]);

  return value;
}

/**
 * Hook: sanciones vigentes de una lista de usuarios (batch + caché).
 * Para páginas que ya tienen todos los ids a mano (listados de admin).
 */
export function useActiveRestrictions(
  ids: Array<string | null | undefined>,
  enabled: boolean,
): Map<string, ActiveRestrictionSummary | null> {
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join(',');
  const [map, setMap] = useState<Map<string, ActiveRestrictionSummary | null>>(new Map());

  const load = useCallback(() => {
    if (!enabled || !key) {
      setMap(new Map());
      return;
    }
    void fetchActiveRestrictions(key.split(',')).then(setMap);
  }, [key, enabled]);

  useEffect(() => {
    load();
    listeners.add(load);
    return () => {
      listeners.delete(load);
    };
  }, [load]);

  return map;
}

/** Convierte la duración elegida en el ISO que espera la API. */
export function expiresAtFromDuration(duration: DurationValue): string | null {
  const found = RESTRICTION_DURATIONS.find((d) => d.value === duration);
  if (!found || found.hours === null) return null;
  return new Date(Date.now() + found.hours * 3600_000).toISOString();
}

/** Texto corto de vigencia para listas y tooltips. */
export function restrictionSummary(r: Restriction): string {
  const areas = r.scopeLabels.join(', ');
  if (!r.expiresAt) return `${areas} · permanente`;
  return `${areas} · hasta ${new Date(r.expiresAt).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })}`;
}
