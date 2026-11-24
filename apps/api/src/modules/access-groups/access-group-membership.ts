/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Pertenencia a los grupos de acceso, como la necesitan los módulos que
 * restringen contenido por nivel de membresía (mod.community para sus espacios,
 * mod.zoom-live para sus clases). Cada nivel de membresía es un grupo de acceso.
 *
 * Vive aquí, junto al host de mod.access-groups, porque es su dueño: es la ÚNICA
 * pieza que lee `mod_access_groups_*` para otros módulos (ADR-016). Ellos
 * reciben este puerto ya construido por el registro (mismo patrón que
 * `buildCourseSaleChecker` o `cierrePorNivel`), y no tocan estas tablas.
 *
 * Reglas, iguales para todos los que lo usan:
 *  - Solo cuentan las membresías ACTIVAS (`REVOKED` no da acceso).
 *  - Solo cuentan los grupos VIVOS: un grupo borrado no abre nada, ni aunque
 *    quede alguna fila de miembro sin revocar.
 *  - Todo va acotado por `tenant_id` (y además la RLS de la base).
 */

/** El puerto que reciben los módulos (estructural: cada uno declara el suyo). */
export interface AccessGroupMembershipPort {
  activeGroupIdsOf(tenantId: string, userId: string): Promise<string[]>;
  activeMembersAmong(tenantId: string, groupIds: string[], userIds: string[]): Promise<string[]>;
  groupNames(tenantId: string, groupIds: string[]): Promise<Array<{ id: string; name: string }>>;
}

/** Lo único que este fichero lee de Prisma. */
export interface AccessGroupMembershipDb {
  modAccessGroupMember: {
    findMany(args: {
      where: {
        tenantId: string;
        status: 'ACTIVE';
        userId?: string | { in: string[] };
        groupId?: { in: string[] };
        group: { tenantId: string; deletedAt: null };
      };
      select: { groupId?: true; userId?: true };
    }): Promise<Array<{ groupId?: string; userId?: string }>>;
  };
  modAccessGroup: {
    findMany(args: {
      where: { tenantId: string; deletedAt: null; id?: { in: string[] } };
      select: { id: true; name: true };
      orderBy: { name: 'asc' };
    }): Promise<Array<{ id: string; name: string }>>;
  };
}

export function buildAccessGroupMembership(
  getDb: () => AccessGroupMembershipDb,
): AccessGroupMembershipPort {
  return {
    async activeGroupIdsOf(tenantId, userId) {
      const rows = await getDb().modAccessGroupMember.findMany({
        where: { tenantId, userId, status: 'ACTIVE', group: { tenantId, deletedAt: null } },
        select: { groupId: true },
      });
      return [...new Set(rows.map((r) => r.groupId).filter((g): g is string => Boolean(g)))];
    },

    async activeMembersAmong(tenantId, groupIds, userIds) {
      if (groupIds.length === 0 || userIds.length === 0) return [];
      const rows = await getDb().modAccessGroupMember.findMany({
        where: {
          tenantId,
          status: 'ACTIVE',
          groupId: { in: [...new Set(groupIds)] },
          userId: { in: [...new Set(userIds)] },
          group: { tenantId, deletedAt: null },
        },
        select: { userId: true },
      });
      return [...new Set(rows.map((r) => r.userId).filter((u): u is string => Boolean(u)))];
    },

    async groupNames(tenantId, groupIds) {
      if (groupIds.length === 0) return [];
      return listAccessGroupOptions(getDb(), tenantId, groupIds);
    },
  };
}

/**
 * Grupos vivos del aula como opciones de «Quién puede verlo» (`{ id, name }`),
 * por nombre. Con `ids`, solo esos.
 */
export function listAccessGroupOptions(
  db: AccessGroupMembershipDb,
  tenantId: string,
  ids?: string[],
): Promise<Array<{ id: string; name: string }>> {
  return db.modAccessGroup.findMany({
    where: { tenantId, deletedAt: null, ...(ids ? { id: { in: [...new Set(ids)] } } : {}) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}
