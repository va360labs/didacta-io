/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface Notification {
  id: string;
  tenantId: string;
  userId: string;
  channel: 'EMAIL' | 'IN_APP' | 'WEBHOOK';
  templateKey: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown>;
  readAt: string | null;
  sentAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const notificationsApi = {
  async listMine(): Promise<Notification[]> {
    return apiFetch<Notification[]>('/api/v1/me/notifications', { method: 'GET' }, withAuth());
  },
  async markRead(id: string): Promise<void> {
    await apiFetch<{ read: true }>(
      `/api/v1/me/notifications/${id}/read`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
  async markAllRead(): Promise<{ count: number }> {
    return apiFetch<{ count: number }>(
      '/api/v1/me/notifications/read-all',
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
  /**
   * Pide al backend un ticket JWT de corta duración (~60s) para abrir el
   * stream SSE. `EventSource` no admite cabeceras custom (Authorization), así
   * que el flujo es: POST con Bearer → {ticket} → GET stream?ticket=<jwt>.
   * El ticket caduca rápido; se pide uno nuevo en cada (re)conexión.
   */
  async getStreamTicket(): Promise<{ ticket: string }> {
    return apiFetch<{ ticket: string }>(
      '/api/v1/me/notifications/stream-ticket',
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
};
