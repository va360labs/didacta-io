/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente HTTP del controlador admin de licencia
 * (`apps/api/src/license/license-admin.controller.ts`, `/admin/license`,
 * super_admin-only). Distinto de `useLicense()` (`@didacta/license-sdk/react`),
 * que consume el estado PÚBLICO sin secretos (`GET /api/license`) — este
 * cliente gestiona la clave (pegar/borrar) y ve metadata que el endpoint
 * público no expone (`managedByEnv`, `hasKeyConfigured`, `updatedAt`).
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface AdminLicenseStatusDto {
  status: 'community' | 'active' | 'grace' | 'expired' | 'invalid' | 'dev';
  source: 'env' | 'admin-panel' | 'config' | 'dev-bypass' | 'unknown';
  managedByEnv: boolean;
  hasKeyConfigured: boolean;
  updatedAt: string | null;
  licenseId?: string;
  customerId?: string;
  organizationId?: string;
  organizationName?: string;
  plan?: string;
  edition?: 'community' | 'enterprise' | 'cloud';
  issuedAt?: string;
  expiresAt?: string;
  capabilities: string[];
  warnings: string[];
  loadedAt: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const adminLicenseApi = {
  async get(): Promise<AdminLicenseStatusDto> {
    return apiFetch<AdminLicenseStatusDto>('/api/v1/admin/license', { method: 'GET' }, withAuth());
  },
  async setKey(key: string): Promise<AdminLicenseStatusDto> {
    return apiFetch<AdminLicenseStatusDto>(
      '/api/v1/admin/license',
      { method: 'PUT', body: JSON.stringify({ key }) },
      withAuth(),
    );
  },
  async clearKey(): Promise<AdminLicenseStatusDto> {
    return apiFetch<AdminLicenseStatusDto>(
      '/api/v1/admin/license',
      { method: 'DELETE' },
      withAuth(),
    );
  },
  async refresh(): Promise<AdminLicenseStatusDto> {
    return apiFetch<AdminLicenseStatusDto>(
      '/api/v1/admin/license/refresh',
      { method: 'POST' },
      withAuth(),
    );
  },
};

export const LICENSE_STATUS_LABEL: Record<AdminLicenseStatusDto['status'], string> = {
  community: 'Community',
  active: 'Activa',
  grace: 'En periodo de gracia',
  expired: 'Expirada',
  invalid: 'Inválida',
  dev: 'Dev bypass',
};
