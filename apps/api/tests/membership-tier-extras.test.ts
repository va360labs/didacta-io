/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it, vi } from 'vitest';
import type { MembershipPublicTier } from '@didacta/mod-subscriptions';
import {
  TIER_LIVES_MAX,
  withTierExtras,
} from '../src/modules/subscriptions/membership-tier-extras';

/**
 * Tarjetas de /join: cada nivel de pago nombra los espacios y los próximos
 * directos restringidos a su grupo. Solo nombres y fechas; el gratis nada.
 */

function tier(id: string, group: string | null, isFree = false): MembershipPublicTier {
  return {
    id,
    name: id,
    description: null,
    isFree,
    sortOrder: 0,
    accessGroupId: group,
    includes: { allCourses: false, courses: [] },
    planIds: [],
  };
}

const page = {
  tiers: [tier('basico', 'g_b'), tier('pro', 'g_p'), tier('gratis', 'g_g', true)],
};

describe('withTierExtras', () => {
  it('reparte espacios y directos por el grupo de cada nivel de pago, sin ids ni enlaces', async () => {
    const spaces = vi.fn(async () => [
      { slug: 'pro-lounge', title: 'Sala Pro', accessGroupIds: ['g_p'] },
      { slug: 'todos-pago', title: 'Socios', accessGroupIds: ['g_b', 'g_p'] },
    ]);
    const lives = vi.fn(async () => [
      {
        id: 'l1',
        title: 'Directo Pro',
        startTime: new Date('2026-12-01T18:00:00Z'),
        accessGroupIds: ['g_p'],
        joinUrl: 'https://zoom/secreto',
      },
    ]);
    const res = await withTierExtras(page, { spaces, lives });
    // Solo los grupos de los niveles de PAGO se consultan.
    expect(spaces).toHaveBeenCalledWith(['g_b', 'g_p']);
    const byId = new Map(res.tiers.map((t) => [t.id, t.includes]));
    expect(byId.get('basico')).toMatchObject({ spaces: [{ name: 'Socios' }], lives: [] });
    expect(byId.get('pro')).toMatchObject({
      spaces: [{ name: 'Sala Pro' }, { name: 'Socios' }],
      lives: [{ title: 'Directo Pro', startTime: '2026-12-01T18:00:00.000Z' }],
    });
    expect(JSON.stringify(res)).not.toContain('zoom/secreto');
    expect(JSON.stringify(res)).not.toContain('pro-lounge');
    expect(byId.get('gratis')).toEqual({ allCourses: false, courses: [] });
  });

  it(`como mucho ${TIER_LIVES_MAX} directos por nivel`, async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `D${i}`,
      startTime: new Date(Date.UTC(2026, 11, i + 1)),
      accessGroupIds: ['g_b'],
    }));
    const res = await withTierExtras(page, { spaces: null, lives: async () => many });
    expect(res.tiers[0]!.includes.lives).toHaveLength(TIER_LIVES_MAX);
    expect(res.tiers[0]!.includes.spaces).toEqual([]);
  });

  it('sin módulos de comunidad ni directos, la página sale tal cual', async () => {
    expect(await withTierExtras(page, { spaces: null, lives: null })).toBe(page);
  });
});
