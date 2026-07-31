'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError } from './api-client';
import { authStorage } from './auth-storage';

export type InstalledModuleStatus = 'INSTALLING' | 'INSTALLED' | 'FAILED' | 'DEPRECATED';
export type InstalledModuleVendor = 'DIDACTA' | 'COMMUNITY';
/// Origen de instalación (DISC-002). Determina badge y nivel de confianza.
export type InstalledModuleSource =
  | 'MARKETPLACE_OFFICIAL'
  | 'MARKETPLACE_COMMUNITY'
  | 'DIRECT_UPLOAD';

export interface InstalledModuleSummary {
  id: string;
  name: string;
  version: string;
  prevVersion: string | null;
  vendor: InstalledModuleVendor;
  /// Origen de la instalación (DISC-002).
  source: InstalledModuleSource;
  displayName: string;
  description: string | null;
  coreVersionRequired: string;
  tablePrefix: string;
  apiNamespace: string;
  requiredCapabilities: string[];
  requiredEnvVars: string[];
  isolation: string;
  status: InstalledModuleStatus;
  errorMessage: string | null;
  signedAt: string | null;
  packageStorageKey: string;
  packageSha256: string;
  packageSizeBytes: number;
  installedById: string;
  installedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstallSuccessResponse {
  id: string;
  name: string;
  version: string;
  status: InstalledModuleStatus;
  manifest: Record<string, unknown>;
  packageStorageKey: string;
  packageSha256: string;
  installedAt: string | null;
  /// Origen de la instalación (DISC-002).
  source: InstalledModuleSource;
  /// `true` si la firma ES256 fue verificada correctamente.
  signatureVerified: boolean;
  /// Error de firma si `signatureVerified=false`. Para mostrar warning en UI.
  signatureError?: string;
}

export interface ModuleRouteSummary {
  moduleName: string;
  method: string;
  path: string;
}

const API_URL = typeof window === 'undefined' ? (process.env.API_INTERNAL_URL ?? '') : '';

/// Cliente del marketplace. Hace `fetch` directo (no usa el helper común
/// `apiFetch`) porque el upload es body crudo `application/zip`, no JSON,
/// y el helper común fuerza `Content-Type: application/json` cuando hay body.
async function rawFetch<T>(
  path: string,
  init: RequestInit = {},
  expect: 'json' | 'empty' = 'json',
): Promise<T> {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    let body: { code?: string; message?: string; details?: unknown } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }
    throw new ApiHttpError({
      message: body.message ?? `HTTP ${response.status}`,
      status: response.status,
      code: body.code,
    });
  }
  if (expect === 'empty') return null as T;
  return text ? (JSON.parse(text) as T) : (null as T);
}

export const marketplaceApi = {
  /// Sube un `*.zip`. El `file` puede ser un Blob/File del input
  /// del usuario. Devuelve el InstallResult del orquestador.
  async install(file: File | Blob): Promise<InstallSuccessResponse> {
    return rawFetch<InstallSuccessResponse>('/api/v1/admin/modules/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    });
  },

  async list(
    filters: {
      status?: InstalledModuleStatus;
      vendor?: InstalledModuleVendor;
    } = {},
  ): Promise<{ modules: InstalledModuleSummary[] }> {
    const qs = new URLSearchParams();
    if (filters.status) qs.set('status', filters.status);
    if (filters.vendor) qs.set('vendor', filters.vendor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return rawFetch<{ modules: InstalledModuleSummary[] }>(
      `/api/v1/admin/modules/installed${suffix}`,
      { method: 'GET' },
    );
  },

  async findOne(name: string): Promise<InstalledModuleSummary> {
    return rawFetch<InstalledModuleSummary>(
      `/api/v1/admin/modules/installed/${encodeURIComponent(name)}`,
      { method: 'GET' },
    );
  },

  async listRoutes(name: string): Promise<{ routes: ModuleRouteSummary[] }> {
    return rawFetch<{ routes: ModuleRouteSummary[] }>(
      `/api/v1/admin/modules/installed/${encodeURIComponent(name)}/routes`,
      { method: 'GET' },
    );
  },

  async uninstall(name: string): Promise<void> {
    await rawFetch<null>(
      `/api/v1/admin/modules/installed/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
      'empty',
    );
  },
};
