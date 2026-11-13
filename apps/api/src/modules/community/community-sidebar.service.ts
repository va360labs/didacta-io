/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Optional } from '@nestjs/common';
import { parseSocialLinks, type SocialLink } from '@didacta/mod-theming';
import { PrismaService } from '../../prisma/prisma.service';
import { MessagingPresenceService } from '../messaging/messaging-presence.service';
import { ModuleRegistryService } from '../module-registry.service';
import { TenantModulesService } from '../tenant-modules.service';

/**
 * Barra lateral del feed de la comunidad, en UNA llamada.
 *
 * Mezcla la tarjeta del grupo de Skool (quiénes somos, cuántos, quién está) y
 * la barra viva del aula de VA360 (ranking, últimos comentarios). TODO sale de
 * la base o de la presencia real, y cada bloque viene `null` (o vacío) cuando
 * no hay dato: el web no pinta ni huecos ni ceros de relleno.
 *
 * Lecturas cross-module de SOLO LECTURA y siempre por `tenant_id` (ADR-016,
 * declaradas en `optionalModules` del manifest de mod.community):
 *  - marca: `mod_theming_tenant_theme` (logo, portada, descripción y enlaces),
 *    como `SigninContextService`;
 *  - ranking: el service público de mod.gamification (`leaderboard`);
 *  - presencia: `MessagingPresenceService` (ZSET efímero de mod.messaging).
 *
 * Lo del aula es igual para todos sus miembros, así que se cachea por aula
 * unos segundos: entrar y salir del feed no repite el ranking ni los COUNT.
 * La tarjeta de la academia (nombre, marca, dominio) NO entra en la caché: son
 * tres lecturas por clave, y quien la cambia en Ajustes tiene que verla al
 * volver a la comunidad, no medio minuto después. La presencia también se lee
 * en vivo y cuenta a quien mira; el botón de ajustes (también de quien mira)
 * lo pone el controller.
 */

/** Cuántas caras enseña la tarjeta del aula. */
export const SIDEBAR_FACES = 8;
/** Top del ranking en la barra lateral. */
export const SIDEBAR_LEADERBOARD_SIZE = 5;
/** «Últimos comentarios» en la barra lateral. */
export const SIDEBAR_RECENT_COMMENTS = 3;
/** Vida de la caché por aula. La presencia ya tolera 60 s de retraso. */
export const SIDEBAR_CACHE_TTL_MS = 30_000;
/** Tope de aulas en caché (una instancia sirve muchas en Cloud). */
const SIDEBAR_CACHE_MAX_TENANTS = 500;

/** Quien administra el aula (los mismos que moderan la comunidad). */
const ADMIN_ROLES = ['super_admin', 'tenant_admin'];

export interface SidebarPerson {
  id: string;
  /** Nombre público. `null` = el web pinta su «Miembro» traducido. */
  name: string | null;
  avatarUrl: string | null;
}

export interface SidebarFace extends SidebarPerson {
  online: boolean;
}

export interface SidebarLeader extends SidebarPerson {
  rank: number;
  /** Puntos ganados en el rango del ranking (no el saldo de toda la vida). */
  points: number;
}

export interface SidebarComment {
  id: string;
  postId: string;
  postTitle: string;
  author: SidebarPerson;
  excerpt: string;
  createdAt: string;
}

export interface CommunitySidebarData {
  academy: {
    name: string;
    logoUrl: string | null;
    logoDisplayMode: 'logo_only' | 'logo_and_name';
    /** Portada propia (mod.theming). `null` = banda con el color del aula. */
    coverUrl: string | null;
    /**
     * Descripción propia del aula (mod.theming `about`); si no la hay, su
     * titular de acceso, como hasta ahora. `null` = no se pinta.
     */
    description: string | null;
    /** Dominio público del aula. `null` si solo hay uno local (no se comparte). */
    host: string | null;
    /** Enlaces sociales, solo los válidos y en su orden. Vacío = no se pinta. */
    links: SocialLink[];
  };
  members: {
    total: number;
    /** `null` si no hay ninguno (no se pinta un «0 administradores»). */
    admins: number | null;
    /** `null` sin señal de presencia (mensajería apagada) o sin nadie. */
    online: number | null;
    faces: SidebarFace[];
  };
  /** `null` sin mod.gamification activo o sin puntos en el rango. */
  leaderboard: { range: 'month'; entries: SidebarLeader[] } | null;
  /** Vacío si nadie ha comentado. */
  recentComments: SidebarComment[];
}

type Person = { id: string; name: string | null; avatarUrl: string | null };

/** Lo que es igual para todos los miembros del aula y se cachea. */
interface TenantPart {
  total: number;
  admins: number | null;
  /** Los últimos en llegar, para completar las caras tras los de en línea. */
  recent: Person[];
  presenceOn: boolean;
  leaderboard: CommunitySidebarData['leaderboard'];
  recentComments: SidebarComment[];
}

interface CacheEntry {
  at: number;
  value: TenantPart;
}

@Injectable()
export class CommunitySidebarService {
  private readonly cache = new Map<string, CacheEntry>();
  /** Reloj; los tests de la caché lo sustituyen. */
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly tenantModules: TenantModulesService,
    @Optional() private readonly presence?: MessagingPresenceService,
  ) {}

  /**
   * La barra del aula vista por `viewerId`. Lo del aula sale de la caché; la
   * presencia se lee EN VIVO en cada petición (un ZSET de Redis, barato) y
   * cuenta a quien mira: está pidiendo la página, así que está en línea
   * aunque su stream de tiempo real aún no se haya registrado.
   */
  async get(tenantId: string, viewerId?: string): Promise<CommunitySidebarData> {
    const [part, academy] = await Promise.all([this.tenantPart(tenantId), this.academy(tenantId)]);
    const live = part.presenceOn
      ? await this.online(tenantId, viewerId)
      : { count: 0, users: [] as Person[] };

    const faces: SidebarFace[] = [];
    const seen = new Set<string>();
    for (const u of live.users) {
      if (faces.length >= SIDEBAR_FACES) break;
      faces.push({ ...person(u), online: true });
      seen.add(u.id);
    }
    for (const u of part.recent) {
      if (faces.length >= SIDEBAR_FACES) break;
      if (seen.has(u.id)) continue;
      faces.push({ ...person(u), online: false });
    }

    return {
      academy,
      members: {
        total: part.total,
        admins: part.admins,
        online: live.count > 0 ? live.count : null,
        faces,
      },
      leaderboard: part.leaderboard,
      recentComments: part.recentComments,
    };
  }

  /** Olvida la caché de un aula (o de todas). */
  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  private async tenantPart(tenantId: string): Promise<TenantPart> {
    const now = this.clock();
    const hit = this.cache.get(tenantId);
    if (hit && now - hit.at < SIDEBAR_CACHE_TTL_MS) return hit.value;

    const value = await this.build(tenantId);
    if (this.cache.size >= SIDEBAR_CACHE_MAX_TENANTS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(tenantId);
    this.cache.set(tenantId, { at: now, value });
    return value;
  }

  private async build(tenantId: string): Promise<TenantPart> {
    const enabled = await this.enabledModules(tenantId);
    const active = { tenantId, status: 'ACTIVE' as const, deletedAt: null };
    const [total, admins, recent, leaderboard, recentComments] = await Promise.all([
      this.prisma.user.count({ where: active }),
      this.prisma.user.count({
        where: { ...active, roles: { some: { role: { name: { in: ADMIN_ROLES } } } } },
      }),
      this.prisma.user.findMany({
        where: active,
        select: { id: true, name: true, avatarUrl: true },
        orderBy: { createdAt: 'desc' },
        take: SIDEBAR_FACES,
      }),
      enabled.has('mod.gamification') ? this.leaderboard(tenantId) : Promise.resolve(null),
      this.recentComments(tenantId),
    ]);
    return {
      total,
      admins: admins > 0 ? admins : null,
      recent,
      // Sin mensajería no hay stream y, por tanto, no hay señal de presencia.
      presenceOn: enabled.has('mod.messaging') && this.presence !== undefined,
      leaderboard,
      recentComments,
    };
  }

  private async enabledModules(tenantId: string): Promise<Set<string>> {
    const list = await this.tenantModules.list(tenantId);
    return new Set(list.filter((m) => m.enabled).map((m) => m.name));
  }

  private async academy(tenantId: string): Promise<CommunitySidebarData['academy']> {
    const [tenant, theme, domain] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.prisma.modThemingTenantTheme.findUnique({
        where: { tenantId },
        select: {
          logoUrl: true,
          logoDisplayMode: true,
          signinHeadline: true,
          about: true,
          coverUrl: true,
          socialLinks: true,
        },
      }),
      this.prisma.tenantDomain.findFirst({
        where: { tenantId, isPrimary: true, surface: 'APP' },
        select: { hostname: true },
      }),
    ]);
    // La descripción propia manda; sin ella, el titular con el que el aula ya
    // se presenta en su pantalla de acceso (lo que se enseñaba hasta ahora).
    const description = theme?.about?.trim() || theme?.signinHeadline?.trim();
    return {
      name: tenant?.name ?? '',
      logoUrl: theme?.logoUrl ?? null,
      logoDisplayMode: theme?.logoDisplayMode === 'logo_and_name' ? 'logo_and_name' : 'logo_only',
      coverUrl: theme?.coverUrl ?? null,
      description: description ? description : null,
      host: domain && isShareableHost(domain.hostname) ? domain.hostname : null,
      // JSON libre en la base: solo salen los enlaces que el DTO aceptaría.
      links: parseSocialLinks(theme?.socialLinks),
    };
  }

  /**
   * Quién está en línea ahora: la presencia del aula más quien mira. Solo
   * cuentan miembros activos de ESTA aula (una id ajena o de una cuenta
   * borrada en el ZSET no suma). Si la presencia recortó su lista (más de 200
   * a la vez), vale su total.
   */
  private async online(
    tenantId: string,
    viewerId: string | undefined,
  ): Promise<{ count: number; users: Person[] }> {
    const snapshot = await this.presence!.snapshot(tenantId);
    const ids = new Set(snapshot.onlineUserIds);
    if (viewerId) ids.add(viewerId);
    if (ids.size === 0) return { count: 0, users: [] };
    const where = {
      tenantId,
      status: 'ACTIVE' as const,
      deletedAt: null,
      id: { in: [...ids] },
    };
    const [count, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: { id: true, name: true, avatarUrl: true },
        orderBy: { createdAt: 'asc' },
        take: SIDEBAR_FACES,
      }),
    ]);
    const truncated = snapshot.onlineCount > snapshot.onlineUserIds.length;
    return { count: truncated ? Math.max(count, snapshot.onlineCount) : count, users };
  }

  private async leaderboard(tenantId: string): Promise<CommunitySidebarData['leaderboard']> {
    // Con margen: si alguien del top ya no es miembro activo, entra el siguiente.
    const board = await this.registry
      .getGamificationService()
      .leaderboard(tenantId, 'month', SIDEBAR_LEADERBOARD_SIZE * 2);
    if (board.rows.length === 0) return null;
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        id: { in: board.rows.map((r) => r.userId) },
      },
      select: { id: true, name: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const entries: SidebarLeader[] = [];
    for (const row of board.rows) {
      const u = byId.get(row.userId);
      if (!u || row.points <= 0) continue;
      // Puestos renumerados tras descartar: sin huecos (1, 2, 4…).
      entries.push({ ...person(u), rank: entries.length + 1, points: row.points });
      if (entries.length >= SIDEBAR_LEADERBOARD_SIZE) break;
    }
    return entries.length > 0 ? { range: 'month', entries } : null;
  }

  private async recentComments(tenantId: string): Promise<SidebarComment[]> {
    const rows = await this.registry
      .getCommunityService()
      .listRecentComments(tenantId, SIDEBAR_RECENT_COMMENTS);
    if (rows.length === 0) return [];
    const authors = await this.prisma.user.findMany({
      where: { tenantId, id: { in: [...new Set(rows.map((r) => r.authorId))] } },
      select: { id: true, name: true, avatarUrl: true },
    });
    const byId = new Map(authors.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = byId.get(r.authorId);
      return {
        id: r.id,
        postId: r.postId,
        postTitle: r.postTitle,
        author: {
          id: r.authorId,
          // El nombre de hoy; si no lo hay, el que firmó, salvo que fuera un correo.
          name: publicName(u?.name) ?? publicName(r.authorDisplayName),
          avatarUrl: u?.avatarUrl ?? null,
        },
        excerpt: r.excerpt,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }
}

function person(u: { id: string; name: string | null; avatarUrl: string | null }): SidebarPerson {
  return { id: u.id, name: publicName(u.name), avatarUrl: u.avatarUrl ?? null };
}

/** Nombre apto para enseñarse a otros miembros: nunca un correo. */
export function publicName(name: string | null | undefined): string | null {
  const n = name?.trim();
  if (!n || n.includes('@')) return null;
  return n;
}

/**
 * Un dominio que tiene sentido enseñar para compartir el aula. `localhost`, las
 * IP y los dominios de laboratorio solo funcionan en la máquina de quien monta.
 */
export function isShareableHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h || !h.includes('.')) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (h.endsWith('.local') || h.endsWith('.test') || h.endsWith('.internal')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
  if (h.includes(':')) return false;
  return true;
}
