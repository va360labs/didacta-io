import { apiFetchAuth } from './_runtime';

export const zoomLiveUiApi = {
  async testCredentials(): Promise<{ kind: 'real' | 'stub'; accountId: string }> {
    return apiFetchAuth<{ kind: 'real' | 'stub'; accountId: string }>(
      '/api/v1/modules/zoom-live/test-credentials',
      { method: 'POST', body: '{}' },
    );
  },

  async upsertCredentials(value: {
    accountId: string;
    clientId: string;
    clientSecret: string;
  }): Promise<void> {
    await apiFetchAuth('/api/v1/tenant-settings/zoom-live/credentials', {
      method: 'PUT',
      body: JSON.stringify({ value, isSecret: true }),
    });
  },

  async removeCredentials(): Promise<void> {
    await apiFetchAuth('/api/v1/tenant-settings/zoom-live/credentials', {
      method: 'DELETE',
    });
  },
};
