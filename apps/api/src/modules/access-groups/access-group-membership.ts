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
  /**
   * Opciones de «Quién puede verlo». Si el aula tiene niveles de pago, SOLO
   * esos niveles, en su orden y con el nombre del nivel (el grupo que adoptó el
   * primer nivel conserva su nombre antiguo, que el creador no reconocería). El
   * nivel gratis no se ofrece: lo que ve el gratis lo ven todos los miembros, y
   * restringir a él dejaría fuera a quien paga. Sin niveles, todos los grupos.
   */
  levelOptions(tenantId: string): Promise<Array<{ id: string; name: string }>>;
}

/** Un nivel de membresía tal como lo ve este fichero (lo pone el registro). */
export interface MembershipLevelName {
  accessGroupId: string | null;
  name: string;
  isFree: boolean;
}

/**
 * Niveles de la membresía del aula, en su orden. Lo inyecta el registro desde
 * mod.subscriptions (dueño de los niveles); sin él, los grupos van con su nombre.
 */
export type MembershipLevelNames = (tenantId: string) => Promise<MembershipLevelName[]>;

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
  levelNames?: MembershipLevelNames,
): AccessGroupMembershipPort {
  // Un fallo leyendo los niveles no debe dejar a nadie sin ver su contenido:
  // los nombres caen a los del grupo y las opciones, a todos los grupos.
  const levels = async (tenantId: string): Promise<MembershipLevelName[]> =>
    levelNames ? levelNames(tenantId).catch(() => []) : [];
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
      const [groups, tiers] = await Promise.all([
        listAccessGroupOptions(getDb(), tenantId, groupIds),
        levels(tenantId),
      ]);
      const tierName = new Map(
        tiers.filter((t) => t.accessGroupId).map((t) => [t.accessGroupId as string, t.name]),
      );
      return groups.map((g) => ({ id: g.id, name: tierName.get(g.id) ?? g.name }));
    },

    async levelOptions(tenantId) {
      const [groups, tiers] = await Promise.all([
        listAccessGroupOptions(getDb(), tenantId),
        levels(tenantId),
      ]);
      const paid = tiers.filter((t) => !t.isFree && t.accessGroupId);
      if (paid.length === 0) return groups;
      const alive = new Set(groups.map((g) => g.id));
      const seen = new Set<string>();
      const out: Array<{ id: string; name: string }> = [];
      for (const t of paid) {
        const id = t.accessGroupId as string;
        if (!alive.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: t.name });
      }
      return out;
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
