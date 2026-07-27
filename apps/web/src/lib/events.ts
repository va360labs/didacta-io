'use client';

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface CommunityEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  capacity: number | null;
  registeredCount: number;
  isFull: boolean;
  isRegistered: boolean;
}

export interface ListEventsQuery {
  from?: string;
  to?: string;
  limit?: number;
  /**
   * Orden por fecha de inicio. `desc` es imprescindible al consultar el
   * pasado: con `asc` el tope de `limit` devuelve los eventos más antiguos
   * del rango y esconde los recientes.
   */
  order?: 'asc' | 'desc';
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new Error('No autenticado');
  return token;
}

export const eventsApi = {
  async list(query: ListEventsQuery = {}): Promise<CommunityEvent[]> {
    const token = withAuth();
    const usp = new URLSearchParams();
    if (query.from) usp.set('from', query.from);
    if (query.to) usp.set('to', query.to);
    if (query.limit) usp.set('limit', String(query.limit));
    if (query.order) usp.set('order', query.order);
    const qs = usp.toString();
    return apiFetch<CommunityEvent[]>(
      `/api/v1/modules/events${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      token,
    );
  },

  async getOne(id: string): Promise<CommunityEvent> {
    const token = withAuth();
    return apiFetch<CommunityEvent>(`/api/v1/modules/events/${id}`, { method: 'GET' }, token);
  },

  async register(id: string): Promise<{ registered: boolean; reason?: string }> {
    const token = withAuth();
    return apiFetch<{ registered: boolean; reason?: string }>(
      `/api/v1/modules/events/${id}/register`,
      { method: 'POST' },
      token,
    );
  },

  async unregister(id: string): Promise<{ unregistered: boolean }> {
    const token = withAuth();
    return apiFetch<{ unregistered: boolean }>(
      `/api/v1/modules/events/${id}/unregister`,
      { method: 'POST' },
      token,
    );
  },
};
