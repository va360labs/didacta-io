/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  buildAccessGroupMembership,
  type AccessGroupMembershipDb,
  type MembershipLevelName,
} from '../src/modules/access-groups/access-group-membership';

/**
 * «Quién puede verlo» de espacios y directos: con niveles de pago se ofrecen
 * los niveles (nombre y orden del nivel, sin el gratis); sin niveles, todos los
 * grupos vivos. El candado dice el nombre del nivel, no el del grupo.
 */

const TENANT = 't-1';

function db(groups: Array<{ id: string; name: string }>): AccessGroupMembershipDb {
  return {
    modAccessGroupMember: { findMany: async () => [] },
    modAccessGroup: {
      findMany: async (args) => {
        const ids = args.where.id?.in;
        return groups
          .filter((g) => !ids || ids.includes(g.id))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  };
}

const GROUPS = [
  { id: 'g-legacy', name: 'Membresía VA' },
  { id: 'g-pro', name: 'Membresía · Pro' },
  { id: 'g-free', name: 'Membresía · Gratis' },
  { id: 'g-fundae', name: 'Curso FUNDAE marzo' },
];

describe('levelOptions', () => {
  it('sin niveles ofrece todos los grupos vivos', async () => {
    const port = buildAccessGroupMembership(
      () => db(GROUPS),
      async () => [],
    );
    const opts = await port.levelOptions(TENANT);
    expect(opts.map((o) => o.id).sort()).toEqual(['g-free', 'g-fundae', 'g-legacy', 'g-pro']);
  });

  it('con niveles de pago ofrece SOLO esos, en su orden y con el nombre del nivel', async () => {
    const tiers: MembershipLevelName[] = [
      { accessGroupId: 'g-free', name: 'Gratis', isFree: true },
      { accessGroupId: 'g-legacy', name: 'Básico', isFree: false },
      { accessGroupId: 'g-pro', name: 'Pro', isFree: false },
    ];
    const port = buildAccessGroupMembership(
      () => db(GROUPS),
      async () => tiers,
    );
    expect(await port.levelOptions(TENANT)).toEqual([
      { id: 'g-legacy', name: 'Básico' },
      { id: 'g-pro', name: 'Pro' },
    ]);
  });

  it('un nivel cuyo grupo está borrado no se ofrece', async () => {
    const port = buildAccessGroupMembership(
      () => db(GROUPS.filter((g) => g.id !== 'g-pro')),
      async () => [
        { accessGroupId: 'g-legacy', name: 'Básico', isFree: false },
        { accessGroupId: 'g-pro', name: 'Pro', isFree: false },
      ],
    );
    expect(await port.levelOptions(TENANT)).toEqual([{ id: 'g-legacy', name: 'Básico' }]);
  });

  it('si leer los niveles falla, cae a todos los grupos (nadie se queda sin opciones)', async () => {
    const port = buildAccessGroupMembership(
      () => db(GROUPS),
      async () => {
        throw new Error('boom');
      },
    );
    expect(await port.levelOptions(TENANT)).toHaveLength(4);
  });
});

describe('groupNames', () => {
  it('pone el nombre del nivel al grupo que es de un nivel y deja el resto', async () => {
    const port = buildAccessGroupMembership(
      () => db(GROUPS),
      async () => [{ accessGroupId: 'g-legacy', name: 'Básico', isFree: false }],
    );
    const names = await port.groupNames(TENANT, ['g-legacy', 'g-fundae']);
    expect(new Map(names.map((n) => [n.id, n.name]))).toEqual(
      new Map([
        ['g-legacy', 'Básico'],
        ['g-fundae', 'Curso FUNDAE marzo'],
      ]),
    );
  });

  it('sin lector de niveles usa el nombre del grupo', async () => {
    const port = buildAccessGroupMembership(() => db(GROUPS));
    expect(await port.groupNames(TENANT, ['g-pro'])).toEqual([
      { id: 'g-pro', name: 'Membresía · Pro' },
    ]);
  });
});
