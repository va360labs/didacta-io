/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import type { TenantApiKey } from './admin-api-keys';
import { liveAgentKeys } from './agent-keys';

const NOW = Date.parse('2026-11-14T12:00:00Z');

function key(over: Partial<TenantApiKey>): TenantApiKey {
  return {
    id: 'k',
    name: 'Agente de IA',
    scopes: ['agent:courses:read', 'agent:courses:write'],
    createdAt: '2026-11-14T10:00:00Z',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    preview: 'dk_live_ab12…',
    createdByEmail: null,
    createdByName: null,
    ...over,
  };
}

describe('liveAgentKeys: las claves que lista el panel del agente', () => {
  it('solo las de agente, vivas, de la más nueva a la más vieja, sin el secreto', () => {
    const out = liveAgentKeys(
      [
        key({ id: 'vieja', createdAt: '2026-11-13T10:00:00Z' }),
        key({ id: 'nueva', createdAt: '2026-11-14T11:00:00Z', lastUsedAt: '2026-11-14T11:30:00Z' }),
        key({ id: 'revocada', revokedAt: '2026-11-14T11:00:00Z' }),
        key({ id: 'caducada', expiresAt: '2026-11-14T11:59:00Z' }),
        key({ id: 'inscribe', scopes: ['inscribe:write'] }),
      ],
      NOW,
    );
    expect(out.map((k) => k.id)).toEqual(['nueva', 'vieja']);
    expect(out[0]).toEqual({
      id: 'nueva',
      preview: 'dk_live_ab12…',
      createdAt: '2026-11-14T11:00:00Z',
      lastUsedAt: '2026-11-14T11:30:00Z',
    });
  });
});
