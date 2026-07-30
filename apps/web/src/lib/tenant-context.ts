'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from './api-client';
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
  /** Copy propio del tenant para el panel de acceso (mod.theming). */
  headline?: string | null;
  subheadline?: string | null;
  /** Color de marca del tenant, para pintar las pantallas sin sesión. */
  brandHue?: number;
  brandSaturation?: number;
  stats?: TenantPublicStats;
  /** El tenant tiene /unete activa: solo entonces el login enlaza la membresía. */
  membershipPageActive?: boolean;
}

export interface TenantContextResponse {
  tenant: TenantPublicInfo | null;
  host: string | null;
}

let cached: TenantContextResponse | null = null;
let inflight: Promise<TenantContextResponse> | null = null;

/**
 * Cliente del endpoint `GET /auth/tenant-context`. Resuelve el tenant del
 * Host actual para que el formulario de signin/signup/forgot pueda esconder
 * el campo "Organización" cuando el dominio ya identifica al tenant.
 *
 * Cachea el resultado en memoria del módulo (válido por sesión del browser).
 * NO usa localStorage porque el host puede cambiar sin que el browser lo note
 * (ej. tras un deploy con nuevo dominio).
 */
export async function fetchTenantContext(): Promise<TenantContextResponse> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = apiFetch<TenantContextResponse>('/api/v1/auth/tenant-context', { method: 'GET' })
    .then((res) => {
      cached = res;
      return res;
    })
    .catch(() => {
      // API unavailable — treat as "no tenant resolved" so the form still renders.
      const fallback: TenantContextResponse = { tenant: null, host: null };
      cached = fallback;
      return fallback;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
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
    if (cached) {
      setTenant(cached.tenant);
      setLoading(false);
      return;
    }
    let aborted = false;
    void fetchTenantContext()
      .then((res) => {
        if (!aborted) {
          setTenant(res.tenant);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
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
  const { tenant } = useTenantContext();
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    setSlug(authStorage.getSession()?.user.tenantSlug ?? null);
  }, []);

  const real = tenant?.name?.trim();
  if (real) return real;
  return slug ? formatTenantName(slug) : 'la organización';
}
