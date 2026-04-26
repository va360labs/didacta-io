'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from './api-client';

export interface TenantContextResponse {
  tenant: { id: string; slug: string; name: string } | null;
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
    void fetchTenantContext().then((res) => {
      if (!aborted) {
        setTenant(res.tenant);
        setLoading(false);
      }
    });
    return () => {
      aborted = true;
    };
  }, []);

  return { loading, tenant };
}
