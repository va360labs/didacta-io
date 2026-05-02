'use client';

import { apiFetch } from './api-client';

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
  /** DNI o NIE español normalizado. NULL si el usuario no lo declaró. */
  documentId: string | null;
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  roles: string[];
}

export interface UpdateProfileInput {
  name?: string;
  locale?: string;
  timezone?: string;
  avatarUrl?: string | null;
  /** Pasar `null` o `''` para borrar el documento. */
  documentId?: string | null;
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
