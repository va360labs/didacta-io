'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
    dto: { email: string; name?: string; role: AssignableRole; accessGroupId?: string },
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
  async startBulkInvite(
    bearer: string,
    dto: {
      rows: BulkInviteRow[];
      role: AssignableRole;
      accessGroupId?: string;
    },
  ): Promise<BulkInviteStartResult> {
    return apiFetch<BulkInviteStartResult>(
      '/api/v1/admin/users/bulk-invite',
      { method: 'POST', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async bulkInviteStatus(bearer: string): Promise<BulkInviteState | null> {
    return apiFetch<BulkInviteState | null>(
      '/api/v1/admin/users/bulk-invite/status',
      { method: 'GET' },
      bearer,
    );
  },
};

export interface BulkInviteRow {
  email: string;
  name?: string;
}

export interface BulkInviteStartResult {
  aceptado: boolean;
  yaEnCurso: boolean;
  total: number;
}

/** Progreso del alta masiva (CSV). Null si nunca se lanzó ninguna. */
export interface BulkInviteState {
  enCurso: boolean;
  total: number;
  creados: number;
  fallidos: Array<{ email: string; error: string }>;
  iniciadoEn: string;
  terminadoEn: string | null;
}

/** ¿Parece un email? Validación laxa (el backend valida en serio con Zod). */
const BULK_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parsea el contenido de un CSV a filas de alta masiva. Mismo criterio que
 * `parsePaymentFlagsCsv`: detecta el separador (`;` o `,`) mirando la
 * cabecera, mapea columnas por nombre (`email`/`correo`, `name`/`nombre`) y,
 * sin cabecera reconocible, trata la primera columna como email y la segunda
 * como nombre. Filas sin un email con forma de email se descartan en
 * silencio — rol y grupo NO van en el CSV: se eligen una vez para todo el
 * lote en el formulario.
 */
export function parseBulkInviteCsv(text: string): BulkInviteRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const headerLine = lines[0]!;
  const sep =
    (headerLine.match(/;/g)?.length ?? 0) >= (headerLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const splitRow = (line: string): string[] =>
    line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));

  const header = splitRow(headerLine).map((h) => h.toLowerCase());
  const emailIdx = header.findIndex((h) => h === 'email' || h === 'e-mail' || h === 'correo');
  const nameIdx = header.findIndex((h) => h === 'name' || h === 'nombre');
  const hasHeader = emailIdx !== -1;

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rows: BulkInviteRow[] = [];
  for (const line of dataLines) {
    const cols = splitRow(line);
    const email = (hasHeader ? cols[emailIdx] : cols[0])?.trim() ?? '';
    if (!BULK_EMAIL_RE.test(email)) continue;
    const rawName = hasHeader && nameIdx !== -1 ? cols[nameIdx] : cols[1];
    rows.push({ email, name: rawName?.trim() || undefined });
  }
  return rows;
}
