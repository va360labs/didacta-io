/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClientContext } from '../auth/client-context';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_SCOPES, SCOPE_ALL, scopeLabels } from './restriction-scopes';

/**
 * Ventana máxima de propagación de una sanción a otras instancias de la API.
 *
 * Mismo TTL que `ModuleAccessInterceptor`, y por el mismo motivo: el
 * interceptor corre en CADA petición mutante, así que sin caché añadiríamos
 * una query por request a un camino calentísimo.
 *
 * La caché es local al proceso. Con varias instancias, sancionar tarda hasta
 * 30 s en cortar en las demás (la instancia que ejecuta la sanción invalida la
 * suya al instante). Es una regresión aceptable frente a lo que había: con el
 * enforcement en los claims del JWT la ventana era el TTL del access token,
 * ~1 h. Si algún día hace falta corte inmediato multi-instancia, el reemplazo
 * es publicar la invalidación por Redis, no bajar este TTL.
 */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  active: ActiveRestriction[];
  /** Primer vencimiento entre las sanciones activas; acorta el TTL si cae antes. */
  expiresAt: number;
}

/** Lo mínimo que necesita el interceptor para bloquear y explicar por qué. */
export interface ActiveRestriction {
  id: string;
  scopes: string[];
  reason: string;
  expiresAt: string | null;
}

export interface RestrictionRecord {
  id: string;
  userId: string;
  scopes: string[];
  scopeLabels: string[];
  reason: string;
  expiresAt: string | null;
  createdAt: string;
  createdById: string;
  createdByName: string | null;
  liftedAt: string | null;
  liftedById: string | null;
  liftedByName: string | null;
  liftReason: string | null;
  /** Calculado: ni levantada ni caducada. */
  active: boolean;
}

export interface CreateRestrictionInput {
  scopes: string[];
  reason: string;
  /** ISO 8601. Ausente o null = permanente. */
  expiresAt?: string | null;
}

const MAX_REASON = 500;

/** La más lejana de dos fechas ISO. */
function maxIso(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

@Injectable()
export class RestrictionService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  /**
   * Sanciones vigentes. Es el método del camino caliente: lo llama el
   * interceptor en cada petición mutante.
   *
   * Devuelve la lista y no solo las áreas porque el 403 tiene que decir el
   * motivo y hasta cuándo dura, y eso vive en la sanción concreta que bloquea.
   */
  async activeRestrictions(tenantId: string, userId: string): Promise<ActiveRestriction[]> {
    const key = `${tenantId}::${userId}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.active;

    const rows = await this.prisma.userRestriction.findMany({
      where: {
        tenantId,
        userId,
        liftedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
      },
      select: { id: true, scopes: true, reason: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const active: ActiveRestriction[] = rows.map((r) => ({
      id: r.id,
      scopes: r.scopes,
      reason: r.reason,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    }));

    // Si alguna sanción vence dentro de la ventana de caché, recorta el TTL
    // para no dejar sancionado a alguien cuya sanción ya expiró.
    let ttl = now + CACHE_TTL_MS;
    for (const r of rows) {
      if (r.expiresAt && r.expiresAt.getTime() < ttl) ttl = r.expiresAt.getTime();
    }

    this.cache.set(key, { active, expiresAt: ttl });
    return active;
  }

  /**
   * Sanciones vigentes de varios usuarios de una vez.
   *
   * Existe para que el escudo del feed pueda pintarse en rojo sin disparar una
   * petición por autor: con 20 posts en pantalla serían 20 llamadas. Mismo
   * criterio que `fetchPublicUsers` en el front.
   *
   * No usa la caché del camino caliente a propósito: aquí el volumen es una
   * query con `IN`, y cachear por lote complicaría la invalidación sin ganar
   * nada — esto lo llama el panel de un admin, no cada request de la API.
   */
  async activeForMany(
    tenantId: string,
    userIds: string[],
  ): Promise<
    Record<string, { scopes: string[]; scopeLabels: string[]; expiresAt: string | null }>
  > {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0) return {};

    const rows = await this.prisma.userRestriction.findMany({
      where: {
        tenantId,
        userId: { in: ids },
        liftedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { userId: true, scopes: true, expiresAt: true },
    });

    const out: Record<
      string,
      { scopes: string[]; scopeLabels: string[]; expiresAt: string | null }
    > = {};
    for (const row of rows) {
      const prev = out[row.userId];
      const scopes = [...new Set([...(prev?.scopes ?? []), ...row.scopes])];
      // Con varias sanciones a la vez, la fecha que se muestra es la más
      // lejana: es cuando el usuario recupera todo. Una permanente (null)
      // gana siempre.
      let expiresAt = prev?.expiresAt ?? null;
      if (prev && prev.expiresAt !== null) {
        expiresAt = row.expiresAt ? maxIso(prev.expiresAt, row.expiresAt.toISOString()) : null;
      } else if (!prev) {
        expiresAt = row.expiresAt?.toISOString() ?? null;
      }
      out[row.userId] = { scopes, scopeLabels: scopeLabels(scopes), expiresAt };
    }
    return out;
  }

  /** Histórico completo, lo consume el expediente. Más reciente primero. */
  async list(tenantId: string, userId: string): Promise<RestrictionRecord[]> {
    const rows = await this.prisma.userRestriction.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'desc' },
    });
    return this.decorate(tenantId, rows);
  }

  async create(
    tenantId: string,
    actorId: string,
    userId: string,
    input: CreateRestrictionInput,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<RestrictionRecord> {
    const scopes = [...new Set(input.scopes ?? [])];
    if (scopes.length === 0) {
      throw new BadRequestException({
        message: 'Indica al menos un área a sancionar.',
        code: 'MODERATION_SCOPES_REQUIRED',
      });
    }
    const invalid = scopes.filter((s) => !ALL_SCOPES.includes(s));
    if (invalid.length > 0) {
      throw new BadRequestException({
        message: `Áreas desconocidas: ${invalid.join(', ')}.`,
        code: 'MODERATION_SCOPES_UNKNOWN',
      });
    }
    // Si viene el comodín, lo demás sobra: guardar ['all'] a secas evita que
    // una sanción total se quede corta cuando se añada un área nueva.
    const normalized = scopes.includes(SCOPE_ALL) ? [SCOPE_ALL] : scopes;

    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException({
        message: 'El motivo es obligatorio.',
        code: 'MODERATION_REASON_REQUIRED',
      });
    }
    if (reason.length > MAX_REASON) {
      throw new BadRequestException({
        message: `El motivo no puede pasar de ${MAX_REASON} caracteres.`,
        code: 'MODERATION_REASON_TOO_LONG',
      });
    }

    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      const parsed = new Date(input.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException({
          message: 'La fecha de fin no es válida.',
          code: 'MODERATION_EXPIRY_INVALID',
        });
      }
      if (parsed.getTime() <= Date.now()) {
        throw new BadRequestException({
          message: 'La fecha de fin tiene que ser futura.',
          code: 'MODERATION_EXPIRY_NOT_FUTURE',
        });
      }
      expiresAt = parsed;
    }

    if (userId === actorId) {
      throw new BadRequestException({
        message: 'No puedes sancionarte a ti mismo.',
        code: 'MODERATION_CANNOT_SANCTION_SELF',
      });
    }

    const target = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
      select: { id: true, roles: { select: { role: { select: { name: true } } } } },
    });
    if (!target)
      throw new NotFoundException({
        message: 'Usuario no encontrado.',
        code: 'MODERATION_USER_NOT_FOUND',
      });

    // Un super_admin no es sancionable desde el panel. Mismo criterio que
    // `TENANT_ASSIGNABLE_ROLES`: el panel nunca toca a quien está por encima.
    if (target.roles.some((r) => r.role.name === 'super_admin')) {
      throw new BadRequestException({
        message: 'No se puede sancionar a un super administrador.',
        code: 'MODERATION_CANNOT_SANCTION_SUPER_ADMIN',
      });
    }

    const row = await this.prisma.userRestriction.create({
      data: { tenantId, userId, scopes: normalized, reason, expiresAt, createdById: actorId },
    });

    this.invalidate(tenantId, userId);

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.user.restricted',
      resourceType: 'user',
      resourceId: userId,
      metadata: {
        restrictionId: row.id,
        scopes: normalized,
        reason,
        expiresAt: expiresAt?.toISOString() ?? null,
        permanent: expiresAt === null,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    const [decorated] = await this.decorate(tenantId, [row]);
    return decorated!;
  }

  async lift(
    tenantId: string,
    actorId: string,
    restrictionId: string,
    liftReason: string | null,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<RestrictionRecord> {
    const existing = await this.prisma.userRestriction.findFirst({
      where: { id: restrictionId, tenantId },
    });
    if (!existing)
      throw new NotFoundException({
        message: 'Sanción no encontrada.',
        code: 'MODERATION_RESTRICTION_NOT_FOUND',
      });
    if (existing.liftedAt) {
      throw new BadRequestException({
        message: 'Esa sanción ya estaba levantada.',
        code: 'MODERATION_RESTRICTION_ALREADY_LIFTED',
      });
    }

    const trimmed = (liftReason ?? '').trim().slice(0, MAX_REASON) || null;

    const row = await this.prisma.userRestriction.update({
      where: { id: restrictionId },
      data: { liftedAt: new Date(), liftedById: actorId, liftReason: trimmed },
    });

    this.invalidate(tenantId, existing.userId);

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.user.restriction_lifted',
      resourceType: 'user',
      resourceId: existing.userId,
      metadata: { restrictionId, scopes: existing.scopes, liftReason: trimmed },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    const [decorated] = await this.decorate(tenantId, [row]);
    return decorated!;
  }

  invalidate(tenantId?: string, userId?: string): void {
    if (tenantId && userId) {
      this.cache.delete(`${tenantId}::${userId}`);
      return;
    }
    this.cache.clear();
  }

  /** Resuelve los nombres de quien sancionó y quien levantó, en un solo viaje. */
  private async decorate(
    tenantId: string,
    rows: Array<{
      id: string;
      userId: string;
      scopes: string[];
      reason: string;
      expiresAt: Date | null;
      createdAt: Date;
      createdById: string;
      liftedAt: Date | null;
      liftedById: string | null;
      liftReason: string | null;
    }>,
  ): Promise<RestrictionRecord[]> {
    const actorIds = [
      ...new Set(
        rows.flatMap((r) => [r.createdById, r.liftedById]).filter((v): v is string => !!v),
      ),
    ];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds }, tenantId },
          select: { id: true, name: true, email: true },
        })
      : [];
    const nameOf = new Map(actors.map((a) => [a.id, a.name ?? a.email]));
    const now = Date.now();

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      scopes: r.scopes,
      scopeLabels: scopeLabels(r.scopes),
      reason: r.reason,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      createdById: r.createdById,
      createdByName: nameOf.get(r.createdById) ?? null,
      liftedAt: r.liftedAt?.toISOString() ?? null,
      liftedById: r.liftedById,
      liftedByName: r.liftedById ? (nameOf.get(r.liftedById) ?? null) : null,
      liftReason: r.liftReason,
      active: !r.liftedAt && (!r.expiresAt || r.expiresAt.getTime() > now),
    }));
  }
}
