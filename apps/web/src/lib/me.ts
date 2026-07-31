'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  /** Biografía corta opcional (máx 280). NULL si no la declaró. */
  bio: string | null;
  /** Cargo/puesto (ej. "Director de Formación"). NULL si no lo declaró. */
  jobTitle: string | null;
  /** Departamento/área (ej. "Talento y Cultura"). NULL si no lo declaró. */
  department: string | null;
  /** Ubicación libre (ej. "Madrid, España"). NULL si no la declaró. */
  location: string | null;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
  /** DNI o NIE español normalizado. NULL si el usuario no lo declaró. */
  documentId: string | null;
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** ISO de cuándo completó el onboarding, o NULL si aún no. */
  onboardingCompletedAt: string | null;
  roles: string[];
}

export interface UpdateProfileInput {
  name?: string;
  /** Pasar `null` o `''` para borrar la bio. */
  bio?: string | null;
  /** Cargo/puesto. `null`/`''` lo borran. */
  jobTitle?: string | null;
  /** Departamento. `null`/`''` lo borran. */
  department?: string | null;
  /** Ubicación. `null`/`''` la borran. */
  location?: string | null;
  locale?: string;
  timezone?: string;
  avatarUrl?: string | null;
  /** Pasar `null` o `''` para borrar el documento. */
  documentId?: string | null;
}

export type NotificationPrefCategory = 'COMMUNITY' | 'LEARNING' | 'ASSESSMENTS' | 'SYSTEM';
export type NotificationPrefChannel = 'EMAIL' | 'IN_APP';

export interface NotificationPreference {
  category: NotificationPrefCategory;
  channel: NotificationPrefChannel;
  enabled: boolean;
}

export interface OnboardingStatus {
  completed: boolean;
  completedAt: string | null;
  /** Campos obligatorios pendientes: 'name' | 'avatar'. */
  missing: string[];
}

export interface ActiveSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}

export const meApi = {
  async getProfile(bearer: string): Promise<UserProfile> {
    return apiFetch<UserProfile>('/api/v1/me/profile', { method: 'GET' }, bearer);
  },
  async updateProfile(bearer: string, dto: UpdateProfileInput): Promise<UserProfile> {
    return apiFetch<UserProfile>(
      '/api/v1/me/profile',
      { method: 'PATCH', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async changePassword(
    bearer: string,
    dto: { currentPassword: string; newPassword: string },
  ): Promise<{ ok: boolean; message: string }> {
    return apiFetch<{ ok: boolean; message: string }>(
      '/api/v1/me/security/password',
      { method: 'POST', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async listSessions(bearer: string): Promise<ActiveSession[]> {
    return apiFetch<ActiveSession[]>('/api/v1/me/security/sessions', { method: 'GET' }, bearer);
  },
  async revokeSession(bearer: string, id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(
      `/api/v1/me/security/sessions/${id}`,
      { method: 'DELETE' },
      bearer,
    );
  },
  async revokeAllSessions(bearer: string): Promise<{ ok: boolean; revoked: number }> {
    return apiFetch<{ ok: boolean; revoked: number }>(
      '/api/v1/me/security/sessions/revoke-others',
      { method: 'POST' },
      bearer,
    );
  },
  /**
   * Sidebar gating: módulos activos del tenant + capabilities EE de la
   * instancia. Lo consume el layout para filtrar items condicionados a
   * `requiresModule`. Las capabilities EE NO se usan para ocultar — siguen
   * el patrón EeGate (visible-pero-bloqueado).
   */
  async getMyModules(
    bearer: string,
  ): Promise<{ activeModules: string[]; enabledCapabilities: string[] }> {
    return apiFetch<{ activeModules: string[]; enabledCapabilities: string[] }>(
      '/api/v1/me/modules',
      { method: 'GET' },
      bearer,
    );
  },

  // ── Onboarding ─────────────────────────────────────────────────────────────
  async getOnboardingStatus(bearer: string): Promise<OnboardingStatus> {
    return apiFetch<OnboardingStatus>('/api/v1/me/onboarding/status', { method: 'GET' }, bearer);
  },
  async completeOnboarding(
    bearer: string,
  ): Promise<{ ok: boolean; onboardingCompletedAt: string; alreadyCompleted?: boolean }> {
    return apiFetch<{ ok: boolean; onboardingCompletedAt: string; alreadyCompleted?: boolean }>(
      '/api/v1/me/onboarding/complete',
      { method: 'POST' },
      bearer,
    );
  },

  // ── Preferencias de notificación ────────────────────────────────────────────
  async getNotificationPreferences(
    bearer: string,
  ): Promise<{ preferences: NotificationPreference[] }> {
    return apiFetch<{ preferences: NotificationPreference[] }>(
      '/api/v1/me/notification-preferences',
      { method: 'GET' },
      bearer,
    );
  },
  async updateNotificationPreferences(
    bearer: string,
    preferences: NotificationPreference[],
  ): Promise<{ preferences: NotificationPreference[] }> {
    return apiFetch<{ preferences: NotificationPreference[] }>(
      '/api/v1/me/notification-preferences',
      { method: 'PUT', body: JSON.stringify({ preferences }) },
      bearer,
    );
  },
};

const TIMEZONE_GROUPS: Record<string, string[]> = {
  Argentina: [
    'America/Argentina/Buenos_Aires',
    'America/Argentina/Cordoba',
    'America/Argentina/Mendoza',
  ],
  España: ['Europe/Madrid', 'Atlantic/Canary'],
  'América Latina': [
    'America/Mexico_City',
    'America/Sao_Paulo',
    'America/Santiago',
    'America/Bogota',
    'America/Lima',
  ],
  UTC: ['UTC'],
};

export const TIMEZONE_OPTIONS: Array<{ group: string; values: string[] }> = Object.entries(
  TIMEZONE_GROUPS,
).map(([group, values]) => ({ group, values }));

export const LOCALE_OPTIONS = [
  { value: 'es-AR', label: 'Español (Argentina)' },
  { value: 'es-ES', label: 'Español (España)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
];
