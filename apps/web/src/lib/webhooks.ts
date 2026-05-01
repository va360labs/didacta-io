'use client';

/**
 * Cliente HTTP del 10º piloto License SDK — webhooks salientes.
 *
 * Backend:
 *   - `apps/api/src/webhooks/webhooks.controller.ts` (CRUD CE).
 *   - `apps/api/src/webhooks/webhooks-admin.controller.ee.ts` (dead-letter EE).
 *
 * El endpoint `info` NO está gateado por la capability — sirve a la vista
 * community y EE. La página `/admin/webhooks` siempre lo consume al cargar.
 */

import { apiFetch } from './api-client';

export type WebhooksTier = 'community' | 'enterprise';

export interface WebhooksInfo {
  tier: WebhooksTier;
  capability: string;
  limits: {
    maxEndpoints: number;
    maxEventsPerEndpoint: number;
  };
  community: { maxEndpoints: number; maxEventsPerEndpoint: number };
  enterprise: { maxEndpoints: number; maxEventsPerEndpoint: number };
  knownEventTypes: string[];
}

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  secretMasked: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointCreated extends WebhookEndpoint {
  /** Solo presente en la respuesta de POST/rotación de secret. */
  secret: string;
}

export interface CreateWebhookEndpointInput {
  url: string;
  eventTypes: string[];
  secret?: string;
  active?: boolean;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  eventTypes?: string[];
  secret?: string;
  active?: boolean;
}

export interface WebhookDeadLetterItem {
  id: string;
  endpointId: string;
  eventType: string;
  payload: unknown;
  lastError: string;
  attempts: number;
  createdAt: string;
}

export interface WebhookDeadLetterPage {
  items: WebhookDeadLetterItem[];
  count: number;
}

const BASE = '/api/v1/webhooks';
const ADMIN_BASE = '/api/v1/admin/webhooks';

export const webhooksApi = {
  // -------------------------------------------------------------------------
  // CE — CRUD endpoints
  // -------------------------------------------------------------------------

  async info(bearer: string): Promise<WebhooksInfo> {
    return apiFetch<WebhooksInfo>(`${BASE}/info`, { method: 'GET' }, bearer);
  },

  async listEndpoints(bearer: string): Promise<WebhookEndpoint[]> {
    return apiFetch<WebhookEndpoint[]>(`${BASE}/endpoints`, { method: 'GET' }, bearer);
  },

  async getEndpoint(bearer: string, id: string): Promise<WebhookEndpoint> {
    return apiFetch<WebhookEndpoint>(`${BASE}/endpoints/${id}`, { method: 'GET' }, bearer);
  },

  async createEndpoint(
    bearer: string,
    input: CreateWebhookEndpointInput,
  ): Promise<WebhookEndpointCreated> {
    return apiFetch<WebhookEndpointCreated>(
      `${BASE}/endpoints`,
      { method: 'POST', body: JSON.stringify(input) },
      bearer,
    );
  },

  async updateEndpoint(
    bearer: string,
    id: string,
    input: UpdateWebhookEndpointInput,
  ): Promise<WebhookEndpoint | WebhookEndpointCreated> {
    return apiFetch<WebhookEndpoint | WebhookEndpointCreated>(
      `${BASE}/endpoints/${id}`,
      { method: 'PUT', body: JSON.stringify(input) },
      bearer,
    );
  },

  async deleteEndpoint(bearer: string, id: string): Promise<void> {
    await apiFetch<void>(`${BASE}/endpoints/${id}`, { method: 'DELETE' }, bearer);
  },

  // -------------------------------------------------------------------------
  // EE — dead-letter (gateado por @RequiresCapability en backend)
  // -------------------------------------------------------------------------

  async listDeadLetter(bearer: string, limit = 50): Promise<WebhookDeadLetterPage> {
    return apiFetch<WebhookDeadLetterPage>(
      `${ADMIN_BASE}/dead-letter?limit=${limit}`,
      { method: 'GET' },
      bearer,
    );
  },

  async retryDeadLetter(
    bearer: string,
    id: string,
  ): Promise<{ status: string; endpointId: string; eventType: string }> {
    return apiFetch(`${ADMIN_BASE}/dead-letter/${id}/retry`, { method: 'POST' }, bearer);
  },

  async dismissDeadLetter(bearer: string, id: string): Promise<void> {
    await apiFetch<void>(`${ADMIN_BASE}/dead-letter/${id}`, { method: 'DELETE' }, bearer);
  },
};
