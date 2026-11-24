/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { MembershipPublicTier } from '@didacta/mod-subscriptions';

/**
 * Lo que da cada nivel de pago ADEMÁS de sus cursos, para las tarjetas de
 * /join: los espacios de la comunidad y los próximos directos restringidos a
 * su grupo de acceso.
 *
 * Se compone aquí, en el host, porque cruza tres módulos (subscriptions,
 * community y zoom-live) y cada uno se lee por su service público
 * (`listSpaceNamesForGroups`, `listUpcomingForGroups`): ningún módulo lee las
 * tablas de otro. Solo viaja el NOMBRE (y la fecha en los directos): nada del
 * contenido, ni enlaces, ni ids. El nivel gratis no lista nada: lo que se ve
 * gratis lo ve todo el mundo.
 */

export interface TierExtrasSources {
  /** Espacios restringidos a alguno de estos grupos (null = sin mod.community). */
  spaces:
    | ((groupIds: string[]) => Promise<Array<{ title: string; accessGroupIds: string[] }>>)
    | null;
  /** Próximos directos restringidos a alguno de estos grupos (null = sin mod.zoom-live). */
  lives:
    | ((
        groupIds: string[],
      ) => Promise<Array<{ title: string; startTime: Date; accessGroupIds: string[] }>>)
    | null;
}

/** Cuántos próximos directos se nombran como mucho por nivel. */
export const TIER_LIVES_MAX = 5;

export async function withTierExtras<T extends { tiers: MembershipPublicTier[] }>(
  page: T,
  sources: TierExtrasSources,
): Promise<T> {
  const paid = page.tiers.filter((t) => !t.isFree && t.accessGroupId);
  if (paid.length === 0 || (!sources.spaces && !sources.lives)) return page;
  const groupIds = [...new Set(paid.map((t) => t.accessGroupId!))];
  const [spaces, lives] = await Promise.all([
    sources.spaces ? sources.spaces(groupIds) : Promise.resolve([]),
    sources.lives ? sources.lives(groupIds) : Promise.resolve([]),
  ]);
  return {
    ...page,
    tiers: page.tiers.map((tier) => {
      if (tier.isFree || !tier.accessGroupId) return tier;
      const group = tier.accessGroupId;
      return {
        ...tier,
        includes: {
          ...tier.includes,
          spaces: spaces
            .filter((s) => s.accessGroupIds.includes(group))
            .map((s) => ({ name: s.title })),
          lives: lives
            .filter((l) => l.accessGroupIds.includes(group))
            .slice(0, TIER_LIVES_MAX)
            .map((l) => ({ title: l.title, startTime: l.startTime.toISOString() })),
        },
      };
    }),
  };
}
