'use client';

import { apiFetch } from './api-client';

export type UserStatus = 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';

export const ASSIGNABLE_ROLES = [
  'tenant_admin',
  'formador',
  'alumno',
  'auditor',
  'empresa_manager',
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABELS: Record<AssignableRole, string> = {
  tenant_admin: 'Administrador',
  formador: 'Formador',
  alumno: 'Alumno',
  auditor: 'Auditor',
  empresa_manager: 'Gerente de empresa',
};

export const STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: 'Activo',
  PENDING: 'Pendiente',
  SUSPENDED: 'Suspendido',
  DEACTIVATED: 'Desactivado',
};

export interface UserListItem {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  roles: string[];
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /// Origen del user cuando fue importado por un módulo (ej. "learndash").
  /// Null para users creados directamente en Didacta. Ver ADR-014.
  externalSource: string | null;
  externalId: string | null;
}

export interface UserDetail extends UserListItem {
  locale: string;
  updatedAt: string;
  recentSessions: Array<{ id: string; createdAt: string; expiresAt: string }>;
}

export interface ListUsersQuery {
  search?: string;
  status?: string;
  role?: string;
  externalSource?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedUsers {
  items: UserListItem[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

function withQuery(path: string, query: ListUsersQuery): string {
  const usp = new URLSearchParams();
  if (query.search) usp.set('search', query.search);
  if (query.status) usp.set('status', query.status);
  if (query.role) usp.set('role', query.role);
  if (query.externalSource) usp.set('externalSource', query.externalSource);
  if (query.page) usp.set('page', String(query.page));
  if (query.limit) usp.set('limit', String(query.limit));
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

export const adminUsersApi = {
  async list(bearer: string, query: ListUsersQuery = {}): Promise<PaginatedUsers> {
    return apiFetch<PaginatedUsers>(
      withQuery('/api/v1/admin/users', query),
      { method: 'GET' },
      bearer,
    );
  },
  async getOne(bearer: string, id: string): Promise<UserDetail> {
    return apiFetch<UserDetail>(`/api/v1/admin/users/${id}`, { method: 'GET' }, bearer);
  },
  async invite(
    bearer: string,
    dto: { email: string; name?: string; role: AssignableRole },
  ): Promise<UserListItem> {
    return apiFetch<UserListItem>(
      '/api/v1/admin/users',
      { method: 'POST', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async setStatus(bearer: string, id: string, status: UserStatus): Promise<UserListItem> {
    return apiFetch<UserListItem>(
      `/api/v1/admin/users/${id}/status`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
      bearer,
    );
  },
  async assignRole(bearer: string, id: string, role: AssignableRole): Promise<UserListItem> {
    return apiFetch<UserListItem>(
      `/api/v1/admin/users/${id}/roles`,
      { method: 'POST', body: JSON.stringify({ role }) },
      bearer,
    );
  },
  async removeRole(bearer: string, id: string, role: AssignableRole): Promise<UserListItem> {
    return apiFetch<UserListItem>(
      `/api/v1/admin/users/${id}/roles/remove`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
      bearer,
    );
  },
  async resendInvite(bearer: string, id: string): Promise<{ ok: true }> {
    return apiFetch<{ ok: true }>(
      `/api/v1/admin/users/${id}/resend-invite`,
      { method: 'POST' },
      bearer,
    );
  },
};
