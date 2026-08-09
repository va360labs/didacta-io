'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';

export type AccessGroupKind = 'ALL_COURSES' | 'COURSE' | 'MULTI_COURSE';

export interface AccessGroupListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: AccessGroupKind;
  isDefaultForApproval: boolean;
  autoGrantNewCourses: boolean;
  linkedTierName: string | null;
  memberCount: number;
  courseCount: number | null;
  createdAt: string;
}

export interface AccessGroupDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: AccessGroupKind;
  isDefaultForApproval: boolean;
  autoGrantNewCourses: boolean;
  linkedTierName: string | null;
  memberCount: number;
  courseIds: string[];
  members: Array<{
    userId: string;
    grantedAt: string;
    name: string | null;
    email: string | null;
    source: string;
  }>;
}

export interface CourseCatalogItem {
  id: string;
  title: string;
  slug: string;
}

export interface UserCandidate {
  id: string;
  name: string | null;
  email: string;
}

export interface CreateAccessGroupInput {
  name: string;
  slug?: string;
  kind: AccessGroupKind;
  description?: string;
  courseIds?: string[];
  autoGrantNewCourses?: boolean;
}

export interface UpdateAccessGroupInput {
  name?: string;
  description?: string | null;
  autoGrantNewCourses?: boolean;
  isDefaultForApproval?: boolean;
  /** Nombre del tier vinculado, o null para desvincular. */
  linkedTierName?: string | null;
}

const BASE = '/api/v1/modules/access-groups';

export const accessGroupsApi = {
  async list(
    bearer: string,
    page = 1,
    limit = 50,
  ): Promise<{ groups: AccessGroupListItem[]; total: number }> {
    return apiFetch<{ groups: AccessGroupListItem[]; total: number }>(
      `${BASE}?page=${page}&limit=${limit}`,
      { method: 'GET' },
      bearer,
    );
  },
  async get(bearer: string, id: string): Promise<AccessGroupDetail> {
    return apiFetch<AccessGroupDetail>(`${BASE}/${id}`, { method: 'GET' }, bearer);
  },
  async create(bearer: string, dto: CreateAccessGroupInput): Promise<AccessGroupDetail> {
    return apiFetch<AccessGroupDetail>(
      `${BASE}`,
      { method: 'POST', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async update(
    bearer: string,
    id: string,
    dto: UpdateAccessGroupInput,
  ): Promise<AccessGroupDetail> {
    return apiFetch<AccessGroupDetail>(
      `${BASE}/${id}`,
      { method: 'PATCH', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async remove(bearer: string, id: string): Promise<{ deleted: boolean; revokedMembers: number }> {
    return apiFetch<{ deleted: boolean; revokedMembers: number }>(
      `${BASE}/${id}`,
      { method: 'DELETE' },
      bearer,
    );
  },
  async setCourses(bearer: string, id: string, courseIds: string[]): Promise<AccessGroupDetail> {
    return apiFetch<AccessGroupDetail>(
      `${BASE}/${id}/courses`,
      { method: 'PUT', body: JSON.stringify({ courseIds }) },
      bearer,
    );
  },
  async assignMembers(
    bearer: string,
    id: string,
    userIds: string[],
  ): Promise<{ assigned: number; added: number }> {
    return apiFetch<{ assigned: number; added: number }>(
      `${BASE}/${id}/members`,
      { method: 'POST', body: JSON.stringify({ userIds }) },
      bearer,
    );
  },
  async revokeMember(bearer: string, id: string, userId: string): Promise<{ revoked: boolean }> {
    return apiFetch<{ revoked: boolean }>(
      `${BASE}/${id}/members/${userId}`,
      { method: 'DELETE' },
      bearer,
    );
  },
  async courseCatalog(bearer: string): Promise<CourseCatalogItem[]> {
    return apiFetch<CourseCatalogItem[]>(`${BASE}/catalog/courses`, { method: 'GET' }, bearer);
  },
  async userCatalog(bearer: string, q: string): Promise<UserCandidate[]> {
    const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    return apiFetch<UserCandidate[]>(`${BASE}/catalog/users${qs}`, { method: 'GET' }, bearer);
  },
};
