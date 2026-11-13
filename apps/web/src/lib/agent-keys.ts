'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';
import { adminApiKeysApi } from './admin-api-keys';
import { authStorage } from './auth-storage';
import { isAgentKey } from './agent-connect';

/** Clave recién creada: el token en claro llega UNA vez y solo vive en memoria. */
export interface CreatedAgentKey {
  id: string;
  token: string;
  scopes: string[];
  mcpPath: string;
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

  /** Cuántas claves de agente siguen vivas en el aula (sin revocar ni caducar). */
  async activeCount(now: number = Date.now()): Promise<number> {
    const keys = await adminApiKeysApi.list(bearer());
    return keys.filter(
      (k) =>
        isAgentKey(k.scopes) &&
        !k.revokedAt &&
        (!k.expiresAt || new Date(k.expiresAt).getTime() > now),
    ).length;
  },

  revoke(id: string): Promise<void> {
    return adminApiKeysApi.revoke(bearer(), id);
  },
};
