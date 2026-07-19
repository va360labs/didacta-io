'use client';

import { apiFetch } from './api-client';

/** Scopes que el admin puede otorgar. Debe coincidir con ALLOWED_API_KEY_SCOPES del backend. */
export const API_KEY_SCOPES = ['enrollments:write', 'courses:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'enrollments:write': 'Inscribir y dar de baja alumnos (POST /inscribe, /inscribe/revoke)',
  'courses:read': 'Listar cursos para mapear productos (GET /inscribe/courses)',
};

export interface TenantApiKey {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  preview: string;
  createdByEmail: string | null;
  createdByName: string | null;
}

/** Respuesta de creación: incluye el token en plano UNA sola vez. */
export interface CreatedApiKey {
  id: string;
  name: string;
  token: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
}

export const adminApiKeysApi = {
  async list(bearer: string): Promise<TenantApiKey[]> {
    return apiFetch<TenantApiKey[]>('/api/v1/admin/api-keys', { method: 'GET' }, bearer);
  },
  async create(
    bearer: string,
    dto: { name: string; scopes: ApiKeyScope[]; expiresAt?: string },
  ): Promise<CreatedApiKey> {
    return apiFetch<CreatedApiKey>(
      '/api/v1/admin/api-keys',
      { method: 'POST', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async revoke(bearer: string, id: string): Promise<void> {
    await apiFetch<void>(`/api/v1/admin/api-keys/${id}`, { method: 'DELETE' }, bearer);
  },
};
