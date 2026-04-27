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

export const adminModulesApi = {
  async list(): Promise<TenantModuleListItem[]> {
    return apiFetch<TenantModuleListItem[]>('/api/v1/admin/modules', { method: 'GET' }, withAuth());
  },
  async enable(name: string): Promise<TenantModuleListItem> {
    return apiFetch<TenantModuleListItem>(
      `/api/v1/admin/modules/${encodeURIComponent(name)}/enable`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
  async disable(name: string, options: { force?: boolean } = {}): Promise<TenantModuleListItem> {
    const qs = options.force ? '?force=true' : '';
    return apiFetch<TenantModuleListItem>(
      `/api/v1/admin/modules/${encodeURIComponent(name)}/disable${qs}`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
};
