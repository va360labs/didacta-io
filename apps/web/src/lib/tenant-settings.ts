/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface TenantSettingMetadata {
  moduleName: string;
  key: string;
  isSecret: boolean;
  hasValue: boolean;
  updatedAt: string;
  updatedById: string | null;
}

export interface TenantSettingDetail extends TenantSettingMetadata {
  /** null cuando isSecret=true (el cleartext nunca sale de la API). */
  value: unknown;
  /**
   * true cuando el ciphertext en DB existe pero no se pudo descifrar (probable
   * causa: la clave que cifró el valor ya no coincide con la actual del
   * cluster — INFRA-FIX-02). El admin tiene que re-tipear el setting para
   * reciclarlo con la clave actual.
   */
  decryptFailed?: boolean;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const tenantSettingsApi = {
  async listAll(): Promise<TenantSettingMetadata[]> {
    return apiFetch<TenantSettingMetadata[]>(
      '/api/v1/tenant-settings',
      { method: 'GET' },
      withAuth(),
    );
  },
  async listScope(scope: string): Promise<TenantSettingMetadata[]> {
    return apiFetch<TenantSettingMetadata[]>(
      `/api/v1/tenant-settings/${encodeURIComponent(scope)}`,
      { method: 'GET' },
      withAuth(),
    );
  },
  async get(scope: string, key: string): Promise<TenantSettingDetail> {
    return apiFetch<TenantSettingDetail>(
      `/api/v1/tenant-settings/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
      { method: 'GET' },
      withAuth(),
    );
  },
  async upsert(
    scope: string,
    key: string,
    payload: { value: unknown; isSecret?: boolean },
  ): Promise<{ ok: true }> {
    return apiFetch<{ ok: true }>(
      `/api/v1/tenant-settings/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ value: payload.value, isSecret: !!payload.isSecret }),
      },
      withAuth(),
    );
  },
  async remove(scope: string, key: string): Promise<{ ok: true }> {
    return apiFetch<{ ok: true }>(
      `/api/v1/tenant-settings/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
  async testSmtp(): Promise<{ ok: true; sentTo: string; messageId?: string }> {
    return apiFetch<{ ok: true; sentTo: string; messageId?: string }>(
      '/api/v1/tenant-settings/notifications/smtp/test',
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
};
