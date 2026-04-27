'use client';

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface TenantModuleListItem {
  name: string;
  version: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  enabledByDefault: boolean;
  dependencies: string[];
  dependents: string[];
  optionalDependencies: string[];
  enabledAt: string | null;
  updatedAt: string | null;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

function withTenant(qs: URLSearchParams, tenantId?: string) {
  if (tenantId) qs.set('tenantId', tenantId);
  return qs.toString() ? `?${qs.toString()}` : '';
}

export const adminModulesApi = {
  async list(tenantId?: string): Promise<TenantModuleListItem[]> {
    const qs = withTenant(new URLSearchParams(), tenantId);
    return apiFetch<TenantModuleListItem[]>(
      `/api/v1/admin/modules${qs}`,
      { method: 'GET' },
      withAuth(),
    );
  },
  async enable(name: string, tenantId?: string): Promise<TenantModuleListItem> {
    const qs = withTenant(new URLSearchParams(), tenantId);
    return apiFetch<TenantModuleListItem>(
      `/api/v1/admin/modules/${encodeURIComponent(name)}/enable${qs}`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
  async disable(
    name: string,
    options: { force?: boolean; tenantId?: string } = {},
  ): Promise<TenantModuleListItem> {
    const params = new URLSearchParams();
    if (options.force) params.set('force', 'true');
    const qs = withTenant(params, options.tenantId);
    return apiFetch<TenantModuleListItem>(
      `/api/v1/admin/modules/${encodeURIComponent(name)}/disable${qs}`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
};
