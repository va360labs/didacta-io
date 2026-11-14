'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import { formatTenantName } from './tenant-name';

/**
 * Cifras REALES del tenant que pinta el panel de marca de /signin. Vienen de
 * dos COUNT del backend; un 0 significa "no hay dato" y la UI oculta el tile
 * en vez de enseñar un número inventado.
 */
export interface TenantPublicStats {
  activeMembers: number;
  publishedCourses: number;
}

export interface TenantPublicInfo {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  /** Cómo se presenta la marca: solo el logo, o logo compacto + nombre. */
  logoDisplayMode?: 'logo_only' | 'logo_and_name';
  /** Copy propio del tenant para el panel de acceso (mod.theming). */
  headline?: string | null;
  subheadline?: string | null;
  /** Color de marca del tenant, para pintar las pantallas sin sesión. */
  brandHue?: number;
  brandSaturation?: number;
  stats?: TenantPublicStats;
  /** El tenant tiene /join activa: solo entonces el login enlaza la membresía. */
  membershipPageActive?: boolean;
  /**
   * Puerta de suscripción, versión pública: `LOCKED` si el aula está en pausa,
   * `OPEN` en cualquier otro caso (la prueba gratis solo la ven sus
   * administradores, por `/me/modules`). Ausente en una API anterior = abierta.
   */
  subscriptionGate?: { state: 'OPEN' | 'LOCKED' };
}

export interface TenantContextResponse {
  tenant: TenantPublicInfo | null;
  host: string | null;
}

let cached: TenantContextResponse | null = null;
let inflight: Promise<TenantContextResponse> | null = null;

/**
 * Última respuesta BUENA de esta pestaña, también en `sessionStorage` para que
 * sobreviva a una recarga. Solo se usa cuando la API no contesta (un 429 del
 * rate limit, un 5xx, la red): mejor la marca de hace un momento que «Tu
 * academia». El almacén es por origen, y el origen es el dominio del aula, así
 * que nunca se cruza la marca de un aula con la de otra.
 */
const LAST_GOOD_KEY = 'didacta.tenant-context';
let lastGood: TenantContextResponse | null = null;

/** Espera ante un fallo que no dice cuánto esperar (API caída, 5xx). */
const RETRY_DEFAULT_MS = 5_000;
/** Tope: la ventana del rate limit es de un minuto. */
const RETRY_MAX_MS = 60_000;
/** Reintentos seguidos como mucho: no se martillea una API caída. */
const MAX_RETRIES = 3;

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
/** Hooks montados: se enteran cuando un reintento trae la respuesta buena. */
const listeners = new Set<(res: TenantContextResponse) => void>();

const NO_TENANT: TenantContextResponse = { tenant: null, host: null };

/** Respuestas de reserva (la API no contestó): ver `isStaleTenantContext`. */
const staleResponses = new WeakSet<TenantContextResponse>();

function fallbackResponse(): TenantContextResponse {
  const res = { ...(readLastGood() ?? NO_TENANT) };
  staleResponses.add(res);
  return res;
}

/**
 * `true` si la respuesta NO viene de la API sino de la reserva (lo último
 * bueno de la pestaña, o «sin aula»). Sirve para pintar, no para decidir: la
 * pantalla de pausa no puede dar el aula por reabierta con un dato de antes.
 */
export function isStaleTenantContext(res: TenantContextResponse): boolean {
  return staleResponses.has(res);
}

function readLastGood(): TenantContextResponse | null {
  if (lastGood) return lastGood;
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(LAST_GOOD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TenantContextResponse> | null;
    if (!parsed || typeof parsed !== 'object' || !('tenant' in parsed)) return null;
    lastGood = { tenant: parsed.tenant ?? null, host: parsed.host ?? null };
    return lastGood;
  } catch {
    return null;
  }
}

function rememberGood(res: TenantContextResponse): void {
  lastGood = res;
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(LAST_GOOD_KEY, JSON.stringify(res));
  } catch {
    // Almacén lleno o bloqueado: queda la copia en memoria.
  }
}

/** Cuánto esperar antes de volver a preguntar: lo que diga `Retry-After`. */
export function tenantContextRetryDelayMs(err: unknown): number {
  const seconds = err instanceof ApiHttpError ? err.retryAfterSeconds : undefined;
  if (typeof seconds === 'number' && seconds > 0) return Math.min(seconds * 1000, RETRY_MAX_MS);
  return RETRY_DEFAULT_MS;
}

function scheduleRetry(delayMs: number): void {
  if (typeof window === 'undefined' || retryTimer || retries >= MAX_RETRIES) return;
  retries += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void fetchTenantContext();
  }, delayMs);
}

/**
 * Cliente del endpoint `GET /auth/tenant-context`. Resuelve el tenant del
 * Host actual para que el formulario de signin/signup/forgot pueda esconder
 * el campo "Organización" cuando el dominio ya identifica al tenant.
 *
 * Cachea el resultado BUENO en memoria del módulo (válido por sesión del
 * browser). Un fallo NO se cachea: antes un solo 429 dejaba la pestaña entera
 * con «Tu academia» y el campo «Organización» hasta recargar. Ahora, ante un
 * fallo, se devuelve la última respuesta buena de la pestaña (o «sin aula» si
 * no la hay) y se vuelve a preguntar UNA vez para todos, cuando la API dice
 * (`Retry-After`). Mientras ese reintento está pendiente no se repite la
 * llamada: gastaría el cupo que justo se ha agotado.
 */
export async function fetchTenantContext(): Promise<TenantContextResponse> {
  if (cached) return cached;
  if (inflight) return inflight;
  if (retryTimer) return fallbackResponse();
  inflight = apiFetch<TenantContextResponse>('/api/v1/auth/tenant-context', { method: 'GET' })
    .then((res) => {
      cached = res;
      retries = 0;
      rememberGood(res);
      for (const listener of listeners) listener(res);
      return res;
    })
    .catch((err: unknown) => {
      // API no disponible: el formulario se pinta igual, con lo último bueno.
      scheduleRetry(tenantContextRetryDelayMs(err));
      return fallbackResponse();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Olvida la respuesta cacheada: la siguiente `fetchTenantContext()` vuelve a
 * preguntar. Lo usa la pantalla de pausa para enterarse de que el aula se ha
 * reabierto sin obligar a nadie a recargar.
 */
export function invalidateTenantContext(): void {
  cached = null;
}

/** Solo para tests: el módulo como recién cargado. */
export function resetTenantContextForTests(): void {
  cached = null;
  inflight = null;
  lastGood = null;
  retries = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  listeners.clear();
}

/**
 * Hook React para consumir el tenant context.
 * Devuelve `{ loading, tenant }`. El componente puede:
 *  - Mostrar skeleton si loading.
 *  - Si tenant !== null: esconder campo "Organización", mostrar nombre.
 *  - Si tenant === null: mostrar campo (modo legacy o dominio no mapeado).
 */
export function useTenantContext(): {
  loading: boolean;
  tenant: TenantContextResponse['tenant'];
} {
  const [tenant, setTenant] = useState<TenantContextResponse['tenant']>(cached?.tenant ?? null);
  const [loading, setLoading] = useState<boolean>(cached === null);

  useEffect(() => {
    let aborted = false;
    const apply = (res: TenantContextResponse) => {
      if (aborted) return;
      setTenant(res.tenant);
      setLoading(false);
    };
    // Si la primera llamada falló, el reintento llega por aquí.
    listeners.add(apply);
    if (cached) {
      apply(cached);
    } else {
      void fetchTenantContext()
        .then(apply)
        .catch(() => {
          if (!aborted) setLoading(false);
        });
    }
    return () => {
      aborted = true;
      listeners.delete(apply);
    };
  }, []);

  return { loading, tenant };
}

/**
 * Nombre de la organización tal y como debe mostrarse en la UI.
 *
 * Misma resolución que el shell autenticado (`(app)/layout.tsx`): nombre REAL
 * del tenant resuelto por host y, si aún no ha cargado o el dominio no está
 * mapeado, el slug de la sesión title-cased. Nunca devuelve cadena vacía, así
 * que se puede interpolar directamente en un título sin dejar un hueco.
 *
 * Devolver un fallback en lugar de `null` es deliberado: estos textos ("Otros
 * cursos de X") se leerían mal a medias mientras carga.
 */
export function useTenantDisplayName(): string {
  const t = useTranslations('libShared');
  const { tenant } = useTenantContext();
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    setSlug(authStorage.getSession()?.user.tenantSlug ?? null);
  }, []);

  const real = tenant?.name?.trim();
  if (real) return real;
  return slug ? formatTenantName(slug) : t('tenantFallbackName');
}
