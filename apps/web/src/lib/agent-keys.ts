'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';
import { adminApiKeysApi, type TenantApiKey } from './admin-api-keys';
import { authStorage } from './auth-storage';
import { isAgentKey } from './agent-connect';

/** Clave recién creada: el token en claro llega UNA vez y solo vive en memoria. */
export interface CreatedAgentKey {
  id: string;
  token: string;
  scopes: string[];
  mcpPath: string;
}

/** Lo que el panel enseña de cada clave de agente viva (nunca el secreto). */
export interface AgentKeyView {
  id: string;
  /** Primeros caracteres de la clave, para reconocerla («dk_live_ab12…»). */
  preview: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Claves de agente vivas (sin revocar ni caducar), de la más nueva a la más
 * vieja. Pura, para poder probarla sin red.
 */
export function liveAgentKeys(keys: readonly TenantApiKey[], now: number): AgentKeyView[] {
  return keys
    .filter(
      (k) =>
        isAgentKey(k.scopes) &&
        !k.revokedAt &&
        (!k.expiresAt || new Date(k.expiresAt).getTime() > now),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((k) => ({
      id: k.id,
      preview: k.preview,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    }));
}

function bearer(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new Error('Sin sesión');
  return token;
}

export const agentKeysApi = {
  /** Los scopes los fija el servidor; aquí solo se pide «una clave de agente». */
  create(): Promise<CreatedAgentKey> {
    return apiFetch<CreatedAgentKey>(
      '/api/v1/agent/keys',
      { method: 'POST', body: JSON.stringify({}) },
      bearer(),
    );
  },

  /**
   * Las claves de agente que siguen vivas en el aula. El panel las lista y deja
   * revocar cada una: antes solo decía «tienes 1 clave» y mandaba a la pantalla
   * técnica de claves API (POST /inscribe, n8n, WooCommerce).
   */
  async listActive(now: number = Date.now()): Promise<AgentKeyView[]> {
    return liveAgentKeys(await adminApiKeysApi.list(bearer()), now);
  },

  revoke(id: string): Promise<void> {
    return adminApiKeysApi.revoke(bearer(), id);
  },
};
