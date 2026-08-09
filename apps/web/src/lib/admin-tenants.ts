'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export interface TenantListItem {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: string;
  domains: Array<{ hostname: string; isPrimary: boolean; isVerified: boolean }>;
  userCount: number;
  courseCount: number;
}

export interface CreateTenantInput {
  slug: string;
  name: string;
  adminEmail: string;
  adminName?: string;
  primaryHostname: string;
}

/**
 * Capacidad multi-tenant (11º piloto License SDK · `feat:multi_tenant.real`).
 * Lo consume `/admin/tenants` para decidir botón Crear vs upsell card.
 */
export interface TenantCapacityInfo {
  tenantCount: number;
  limit: number | null;
  capabilityActive: boolean;
  capability: 'feat:multi_tenant.real';
  canCreate: boolean;
}

export const adminTenantsApi = {
  async list(bearer: string): Promise<TenantListItem[]> {
    return apiFetch<TenantListItem[]>('/api/v1/admin/tenants', { method: 'GET' }, bearer);
  },
  async capacity(bearer: string): Promise<TenantCapacityInfo> {
    return apiFetch<TenantCapacityInfo>(
      '/api/v1/admin/tenants/capacity',
      { method: 'GET' },
      bearer,
    );
  },
  async getOne(bearer: string, id: string): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(`/api/v1/admin/tenants/${id}`, { method: 'GET' }, bearer);
  },
  async create(bearer: string, dto: CreateTenantInput): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      '/api/v1/admin/tenants',
      { method: 'POST', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async setStatus(bearer: string, id: string, status: TenantStatus): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      `/api/v1/admin/tenants/${id}/status`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
      bearer,
    );
  },
  /**
   * Renombra el tenant (`tenant.name`). Backend en alpha.77 expone
   * `PATCH /admin/tenants/:id` con body `{ name: string }` (1-120 chars).
   * El nombre aparece en la firma de los emails ("Equipo {name}") y en el
   * header/sidebar del admin, por lo que cambiarlo suele requerir un
   * reload para refrescar componentes que tienen el valor cacheado.
   */
  async rename(bearer: string, id: string, name: string): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      `/api/v1/admin/tenants/${id}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
      bearer,
    );
  },
  async addDomain(bearer: string, id: string, hostname: string): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      `/api/v1/admin/tenants/${id}/domains`,
      { method: 'POST', body: JSON.stringify({ hostname }) },
      bearer,
    );
  },
  async removeDomain(bearer: string, id: string, hostname: string): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      `/api/v1/admin/tenants/${id}/domains/${encodeURIComponent(hostname)}`,
      { method: 'DELETE' },
      bearer,
    );
  },
};
