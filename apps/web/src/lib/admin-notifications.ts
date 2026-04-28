import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export type NotificationChannel = 'EMAIL' | 'IN_APP' | 'WEBHOOK';

export interface NotificationTemplateOverride {
  id: string;
  tenantId: string;
  key: string;
  channel: NotificationChannel;
  locale: string;
  subject: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const adminNotificationsApi = {
  async listKnownKeys(): Promise<string[]> {
    return apiFetch<string[]>(
      '/api/v1/admin/notifications/templates/keys',
      { method: 'GET' },
      withAuth(),
    );
  },

  async listOverrides(key?: string): Promise<NotificationTemplateOverride[]> {
    const params = new URLSearchParams();
    if (key) params.set('key', key);
    const path = `/api/v1/admin/notifications/templates${params.toString() ? `?${params}` : ''}`;
    return apiFetch<NotificationTemplateOverride[]>(path, { method: 'GET' }, withAuth());
  },

  async upsertOverride(
    key: string,
    input: { channel: NotificationChannel; locale: string; subject: string | null; body: string },
  ): Promise<NotificationTemplateOverride> {
    return apiFetch<NotificationTemplateOverride>(
      `/api/v1/admin/notifications/templates/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async deleteOverride(
    key: string,
    opts: { channel: NotificationChannel; locale: string },
  ): Promise<void> {
    const params = new URLSearchParams({ channel: opts.channel, locale: opts.locale });
    await apiFetch<{ deleted: true }>(
      `/api/v1/admin/notifications/templates/${encodeURIComponent(key)}?${params}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
};
