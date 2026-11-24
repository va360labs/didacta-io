/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PrismaClient } from '@didacta/database';

/**
 * Espacios restringidos por nivel de membresía.
 *
 * Un espacio guarda la lista de grupos de acceso (mod.access-groups; cada nivel
 * de membresía es un grupo) cuyos miembros ACTIVOS lo ven. Lista vacía = lo ven
 * todos los miembros, que es como funcionaba todo antes de esto.
 *
 * Un post pertenece a un espacio por su etiqueta (el slug del espacio va en
 * `tags`, convenio del compositor y de la API). Regla: un post es visible para
 * alguien si, para CADA espacio restringido cuyo slug lleva en `tags`, esa
 * persona es miembro activo de alguno de sus grupos. Si el post está en dos
 * espacios y uno le está cerrado, no lo ve: manda el cierre.
 *
 * El equipo del aula (admin y formador) lo ve todo siempre.
 *
 * Este módulo NO lee las tablas de mod.access-groups: el host le pasa el puerto
 * `AccessGroupMembership` ya resuelto contra el dueño de los grupos (mismo
 * patrón que `cierrePorNivel` de mod.learning). Sin puerto (tests, arranques a
 * medias) nadie es miembro de nada: lo restringido solo lo ve el equipo. Falla
 * cerrado.
 */

/** Puerto que implementa el host con el dueño de los grupos (mod.access-groups). */
export interface AccessGroupMembership {
  /** Grupos VIVOS en los que `userId` es miembro ACTIVO. */
  activeGroupIdsOf(tenantId: string, userId: string): Promise<string[]>;
  /** De `userIds`, quiénes son miembros ACTIVOS de alguno de `groupIds` (vivos). */
  activeMembersAmong(tenantId: string, groupIds: string[], userIds: string[]): Promise<string[]>;
  /** Nombre de los grupos VIVOS de la lista (los borrados no salen). */
  groupNames(tenantId: string, groupIds: string[]): Promise<Array<{ id: string; name: string }>>;
}

/** Nadie es miembro de nada: solo el equipo ve lo restringido. */
export const NO_ACCESS_GROUPS: AccessGroupMembership = {
  activeGroupIdsOf: async () => [],
  activeMembersAmong: async () => [],
  groupNames: async () => [],
};

/** Roles que ven todos los espacios: el equipo del aula. */
export const SPACE_STAFF_ROLES: readonly string[] = ['super_admin', 'tenant_admin', 'formador'];

/** ¿Estos roles son del equipo del aula? */
export function seesAllSpaces(roles: readonly string[]): boolean {
  return roles.some((r) => SPACE_STAFF_ROLES.includes(r));
}

/**
 * Quien mira. `userId` sin rol de equipo: se le aplican los niveles. Sin
 * `userId` y sin ser equipo: no ve nada restringido.
 */
export interface SpaceViewer {
  userId?: string | null;
  seesEverything: boolean;
}

/** Nivel con el que se abre un espacio, tal como se le enseña a quien no lo tiene. */
export interface AccessLevel {
  id: string;
  name: string;
}

interface RestrictedSpace {
  id: string;
  slug: string;
  groupIds: string[];
}

/** Solo lo que este fichero lee de la base. */
type SpaceAccessPrisma = Pick<PrismaClient, 'modCommunitySpace' | 'user'>;

export class SpaceAccess {
  constructor(
    private readonly prisma: SpaceAccessPrisma,
    private readonly membership: AccessGroupMembership = NO_ACCESS_GROUPS,
  ) {}

  /** Espacios del aula con algún nivel. Una consulta; vacía en un aula sin niveles. */
  async restrictedSpaces(tenantId: string): Promise<RestrictedSpace[]> {
    const rows = await this.prisma.modCommunitySpace.findMany({
      where: { tenantId, NOT: { accessGroupIds: { isEmpty: true } } },
      select: { id: true, slug: true, accessGroupIds: true },
    });
    // El filtro se repite aquí: un doble de Prisma (o una fila sin la columna)
    // no puede convertir un espacio abierto en cerrado ni al revés.
    return rows
      .map((r) => ({ id: r.id, slug: r.slug, groupIds: r.accessGroupIds ?? [] }))
      .filter((r) => r.groupIds.length > 0);
  }

  /** Grupos en los que quien mira es miembro activo ([] si no hay persona). */
  async viewerGroups(tenantId: string, viewer: SpaceViewer): Promise<string[]> {
    if (!viewer.userId) return [];
    return this.membership.activeGroupIdsOf(tenantId, viewer.userId);
  }

  /** Slugs de los espacios que quien mira NO puede ver. [] para el equipo. */
  async blockedSlugs(tenantId: string, viewer: SpaceViewer): Promise<string[]> {
    if (viewer.seesEverything) return [];
    const restricted = await this.restrictedSpaces(tenantId);
    if (restricted.length === 0) return [];
    const mine = new Set(await this.viewerGroups(tenantId, viewer));
    return restricted.filter((s) => !s.groupIds.some((g) => mine.has(g))).map((s) => s.slug);
  }

  /**
   * Cláusula `where` de `mod_community_post` que deja fuera los posts de
   * espacios cerrados para quien mira. Objeto vacío si no hay ninguno.
   */
  static postWhere(blocked: readonly string[]): { NOT?: { tags: { hasSome: string[] } } } {
    return blocked.length > 0 ? { NOT: { tags: { hasSome: [...blocked] } } } : {};
  }

  /** ¿Un post con estas etiquetas cae en algún espacio cerrado? */
  static isBlocked(tags: readonly string[], blocked: readonly string[]): boolean {
    if (blocked.length === 0) return false;
    const set = new Set(blocked);
    return tags.some((t) => set.has(t) || set.has(t.toLowerCase()));
  }

  /**
   * De `userIds`, quiénes pueden ver un post con estas etiquetas. Lo usan los
   * avisos (comentarios, menciones, avisos masivos): a quien no puede verlo no
   * se le cuenta nada de él.
   */
  async audienceForTags(
    tenantId: string,
    tags: readonly string[],
    userIds: readonly string[],
  ): Promise<Set<string>> {
    const all = new Set(userIds);
    if (all.size === 0) return all;
    const tagSet = new Set(tags);
    const relevant = (await this.restrictedSpaces(tenantId)).filter((s) => tagSet.has(s.slug));
    if (relevant.length === 0) return all;
    return this.audienceForGroups(
      tenantId,
      relevant.map((s) => s.groupIds),
      [...all],
    );
  }

  /** De `userIds`, quiénes pueden ver el espacio `spaceId`. */
  async audienceForSpace(
    tenantId: string,
    spaceId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    const all = new Set(userIds);
    if (all.size === 0) return all;
    const space = (await this.restrictedSpaces(tenantId)).find((s) => s.id === spaceId);
    if (!space) return all;
    return this.audienceForGroups(tenantId, [space.groupIds], [...all]);
  }

  /**
   * Quiénes de `userIds` pasan TODAS las listas de grupos (una por espacio
   * cerrado): el equipo siempre, y el resto si es miembro activo de algún grupo
   * de cada lista.
   */
  private async audienceForGroups(
    tenantId: string,
    groupLists: string[][],
    userIds: string[],
  ): Promise<Set<string>> {
    const staff = await this.staffAmong(tenantId, userIds);
    let allowed = new Set(userIds);
    for (const groupIds of groupLists) {
      const members = new Set(
        await this.membership.activeMembersAmong(
          tenantId,
          groupIds,
          [...allowed].filter((u) => !staff.has(u)),
        ),
      );
      allowed = new Set([...allowed].filter((u) => staff.has(u) || members.has(u)));
      if (allowed.size === 0) break;
    }
    return allowed;
  }

  /** De `userIds`, quiénes son del equipo del aula (tabla core `user`). */
  async staffAmong(tenantId: string, userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.user.findMany({
      where: {
        tenantId,
        id: { in: [...userIds] },
        roles: { some: { role: { name: { in: [...SPACE_STAFF_ROLES] } } } },
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** Quien mira, resuelto desde la base (para los trabajos en segundo plano). */
  async viewerOf(tenantId: string, userId: string): Promise<SpaceViewer> {
    const staff = await this.staffAmong(tenantId, [userId]);
    return { userId, seesEverything: staff.has(userId) };
  }

  /** Niveles con nombre (solo los grupos que siguen vivos), para «Disponible en». */
  async levels(tenantId: string, groupIds: readonly string[]): Promise<AccessLevel[]> {
    if (groupIds.length === 0) return [];
    return this.membership.groupNames(tenantId, [...new Set(groupIds)]);
  }

  /**
   * Valida que todos los grupos pedidos existen y siguen vivos en el aula.
   * Devuelve la lista sin duplicados o, si falta alguno, su id.
   */
  async checkGroups(
    tenantId: string,
    groupIds: readonly string[],
  ): Promise<{ ok: true; ids: string[] } | { ok: false; missing: string }> {
    const ids = [...new Set(groupIds)];
    if (ids.length === 0) return { ok: true, ids };
    const found = new Set((await this.membership.groupNames(tenantId, ids)).map((g) => g.id));
    const missing = ids.find((id) => !found.has(id));
    return missing ? { ok: false, missing } : { ok: true, ids };
  }
}
