/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * MembershipTiersService — NIVELES de la membresía (Básico, Pro, Gratis…).
 *
 * Un nivel da su propio contenido (un grupo de acceso de mod.access-groups) y
 * se vende con uno o varios planes (`ModSubscriptionsPlan.tierId`: mensual,
 * trimestral, anual…). El nivel gratis no tiene planes: se entra con el
 * registro gratis (mod.member-registration).
 *
 * División de responsabilidades con el host (apps/api), igual que la del resto
 * de la membresía:
 *   - Este service guarda y lee las filas de nivel (tablas de ESTE módulo).
 *   - El grupo de acceso de cada nivel lo crea y lo mantiene el host a través
 *     del service público de mod.access-groups, y aquí solo se apunta su id
 *     (id lógico, sin FK cross-module). Este módulo nunca escribe tablas de
 *     otro.
 *
 * Compatibilidad: sin niveles, cada plan da el grupo de la configuración
 * (`ModSubscriptionsMembershipConfig.accessGroupId`), como siempre.
 */

import type { PrismaClient } from '@didacta/database';
import {
  MembershipTierInUseError,
  MembershipTierInvalidError,
  MembershipTierNotFoundError,
} from './errors.js';

export type TierRow = Awaited<ReturnType<PrismaClient['modSubscriptionsTier']['create']>>;

/** Largo máximo del nombre de un nivel (cabe en una tarjeta de /join). */
export const TIER_NAME_MAX = 60;
/** Largo máximo de la descripción de un nivel. */
export const TIER_DESCRIPTION_MAX = 400;

export interface TierInput {
  name: string;
  description?: string | null;
  isFree?: boolean;
  active?: boolean;
  sortOrder?: number;
}

/**
 * Lo mínimo de un nivel para quien necesite saber qué grupo da (p. ej. la
 * restricción de espacios y directos por grupo de acceso). Lectura pública del
 * módulo: sin precios ni planes.
 */
export interface MembershipTierSummary {
  id: string;
  name: string;
  accessGroupId: string | null;
  isFree: boolean;
}

/** Estados de una suscripción de membresía que siguen dentro del nivel. */
const TIER_LIVE_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'PENDING'] as const;

export class MembershipTiersService {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------------- Lectura ----------------

  /** Todos los niveles del aula (también los apagados), en su orden. */
  async listTiers(tenantId: string): Promise<TierRow[]> {
    return this.prisma.modSubscriptionsTier.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async getTier(tenantId: string, tierId: string): Promise<TierRow> {
    const tier = await this.prisma.modSubscriptionsTier.findFirst({
      where: { id: tierId, tenantId },
    });
    if (!tier) throw new MembershipTierNotFoundError(tierId);
    return tier;
  }

  /** El nivel gratis del aula (encendido o no), o null si no hay. */
  async findFreeTier(tenantId: string): Promise<TierRow | null> {
    return this.prisma.modSubscriptionsTier.findFirst({
      where: { tenantId, isFree: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** ¿El aula vende por niveles? (al menos un nivel de pago, encendido o no). */
  async hasPaidTiers(tenantId: string): Promise<boolean> {
    const count = await this.prisma.modSubscriptionsTier.count({
      where: { tenantId, isFree: false },
    });
    return count > 0;
  }

  /**
   * Lectura pública de los niveles: id, nombre, grupo que dan y si son gratis.
   * Solo los encendidos (los que se ofrecen); `includeInactive` para quien
   * necesite también los apagados (quien ya los paga conserva su acceso).
   */
  async listTierSummaries(
    tenantId: string,
    opts: { includeInactive?: boolean } = {},
  ): Promise<MembershipTierSummary[]> {
    const rows = await this.prisma.modSubscriptionsTier.findMany({
      where: { tenantId, ...(opts.includeInactive ? {} : { active: true }) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, accessGroupId: true, isFree: true },
    });
    return rows;
  }

  /**
   * Grupo que da un plan: el de su nivel o, si es un plan sin nivel, el de la
   * configuración de la membresía (lo de siempre). `null` si no hay grupo.
   */
  async accessGroupForPlan(tenantId: string, planId: string | null): Promise<string | null> {
    if (planId) {
      const plan = await this.prisma.modSubscriptionsPlan.findFirst({
        where: { id: planId, tenantId },
        select: { tierId: true },
      });
      if (plan?.tierId) {
        const tier = await this.prisma.modSubscriptionsTier.findFirst({
          where: { id: plan.tierId, tenantId },
          select: { accessGroupId: true },
        });
        return tier?.accessGroupId ?? null;
      }
    }
    const config = await this.prisma.modSubscriptionsMembershipConfig.findUnique({
      where: { tenantId },
      select: { accessGroupId: true },
    });
    return config?.accessGroupId ?? null;
  }

  /**
   * Grupos que se conceden A CAMBIO DE DINERO por la membresía: el de la
   * configuración y el de cada nivel de pago (también los apagados: quien ya
   * los paga sigue pagándolos). El del nivel gratis NO está.
   */
  async paidMembershipGroupIds(tenantId: string): Promise<string[]> {
    const [config, tiers] = await Promise.all([
      this.prisma.modSubscriptionsMembershipConfig.findUnique({
        where: { tenantId },
        select: { accessGroupId: true },
      }),
      this.prisma.modSubscriptionsTier.findMany({
        where: { tenantId, isFree: false, accessGroupId: { not: null } },
        select: { accessGroupId: true },
      }),
    ]);
    const ids = new Set<string>();
    if (config?.accessGroupId) ids.add(config.accessGroupId);
    for (const t of tiers) if (t.accessGroupId) ids.add(t.accessGroupId);
    return [...ids];
  }

  /**
   * Suscripciones de membresía que siguen dentro de un nivel (sus planes, en
   * cualquier estado que no sea la baja). Para no borrar un nivel que alguien
   * paga.
   */
  async countLiveSubscriptions(tenantId: string, tierId: string): Promise<number> {
    const planIds = await this.planIdsOf(tenantId, tierId);
    if (planIds.length === 0) return 0;
    return this.prisma.modSubscriptionsSubscription.count({
      where: { tenantId, planId: { in: planIds }, status: { in: [...TIER_LIVE_STATUSES] } },
    });
  }

  // ---------------- Escritura ----------------

  /**
   * Crea un nivel. `accessGroupId` lo pone el host (el grupo lo crea él con el
   * service de mod.access-groups). Va al final de la lista salvo que se diga
   * otra cosa. Solo un nivel gratis por aula.
   */
  async createTier(
    tenantId: string,
    input: TierInput & { accessGroupId: string | null },
  ): Promise<TierRow> {
    const name = normalizeTierName(input.name);
    await this.assertNameFree(tenantId, name, null);
    if (input.isFree && (await this.findFreeTier(tenantId))) {
      throw new MembershipTierInvalidError('free_exists');
    }
    const last = await this.prisma.modSubscriptionsTier.findFirst({
      where: { tenantId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return this.prisma.modSubscriptionsTier.create({
      data: {
        tenantId,
        name,
        description: normalizeDescription(input.description),
        accessGroupId: input.accessGroupId,
        isFree: input.isFree ?? false,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? (last ? last.sortOrder + 1 : 0),
      },
    });
  }

  /** Edita nombre, descripción, orden o si está encendido. `isFree` no cambia. */
  async updateTier(
    tenantId: string,
    tierId: string,
    input: Partial<Omit<TierInput, 'isFree'>>,
  ): Promise<TierRow> {
    const tier = await this.getTier(tenantId, tierId);
    const name = input.name !== undefined ? normalizeTierName(input.name) : undefined;
    if (name !== undefined && name !== tier.name)
      await this.assertNameFree(tenantId, name, tier.id);
    return this.prisma.modSubscriptionsTier.update({
      where: { id: tier.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(input.description !== undefined
          ? { description: normalizeDescription(input.description) }
          : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
  }

  /** Apunta el grupo de acceso del nivel (lo crea o lo cambia el host). */
  async setAccessGroup(tenantId: string, tierId: string, accessGroupId: string | null) {
    const tier = await this.getTier(tenantId, tierId);
    return this.prisma.modSubscriptionsTier.update({
      where: { id: tier.id },
      data: { accessGroupId },
    });
  }

  /**
   * Nuevo orden: `tierIds` en el orden en que se quieren ver. Los que no se
   * nombran se quedan detrás, en su orden de antes.
   */
  async reorderTiers(tenantId: string, tierIds: readonly string[]): Promise<TierRow[]> {
    const tiers = await this.listTiers(tenantId);
    const known = new Set(tiers.map((t) => t.id));
    for (const id of tierIds) {
      if (!known.has(id)) throw new MembershipTierNotFoundError(id);
    }
    const ordered = [...tierIds, ...tiers.map((t) => t.id).filter((id) => !tierIds.includes(id))];
    await this.prisma.$transaction(
      ordered.map((id, index) =>
        this.prisma.modSubscriptionsTier.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    return this.listTiers(tenantId);
  }

  /**
   * Borra un nivel que nadie paga: el nivel y sus planes (ninguno vendido). Si
   * algún plan suyo ya tiene suscripciones, NO se borra (historial y acceso de
   * quien lo paga): `MembershipTierInUseError`, se apaga en su lugar. El grupo
   * de acceso lo retira el host.
   */
  async deleteTier(tenantId: string, tierId: string): Promise<TierRow> {
    const tier = await this.getTier(tenantId, tierId);
    const planIds = await this.planIdsOf(tenantId, tier.id);
    if (planIds.length > 0) {
      const sold = await this.prisma.modSubscriptionsSubscription.count({
        where: { tenantId, planId: { in: planIds } },
      });
      if (sold > 0) throw new MembershipTierInUseError(tier.id);
    }
    await this.prisma.$transaction([
      this.prisma.modSubscriptionsPlan.deleteMany({ where: { tenantId, tierId: tier.id } }),
      this.prisma.modSubscriptionsTier.delete({ where: { id: tier.id } }),
    ]);
    return tier;
  }

  /**
   * Primer nivel de pago de un aula que ya vendía membresía: los planes de
   * siempre (sin nivel) pasan a este nivel, para que no queden sueltos. Quien
   * ya los paga no nota nada si el nivel da el mismo grupo (el host le pone el
   * de la configuración). Devuelve cuántos planes se movieron.
   */
  async adoptLegacyPlans(tenantId: string, tierId: string): Promise<number> {
    const tier = await this.getTier(tenantId, tierId);
    if (tier.isFree) return 0;
    const { count } = await this.prisma.modSubscriptionsPlan.updateMany({
      where: { tenantId, tierId: null },
      data: { tierId: tier.id },
    });
    return count;
  }

  /** ¿Hay planes sin nivel en el aula? (los de antes de los niveles) */
  async countLegacyPlans(tenantId: string): Promise<number> {
    return this.prisma.modSubscriptionsPlan.count({ where: { tenantId, tierId: null } });
  }

  // ---------------- Helpers ----------------

  private async planIdsOf(tenantId: string, tierId: string): Promise<string[]> {
    const plans = await this.prisma.modSubscriptionsPlan.findMany({
      where: { tenantId, tierId },
      select: { id: true },
    });
    return plans.map((p) => p.id);
  }

  /** Nombre único por aula, sin distinguir mayúsculas (dos «Pro» confundirían). */
  private async assertNameFree(tenantId: string, name: string, exceptId: string | null) {
    const clash = await this.prisma.modSubscriptionsTier.findFirst({
      where: {
        tenantId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new MembershipTierInvalidError('name_taken');
  }
}

function normalizeTierName(raw: string): string {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new MembershipTierInvalidError('name_required');
  if (name.length > TIER_NAME_MAX) throw new MembershipTierInvalidError('name_too_long');
  return name;
}

function normalizeDescription(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  if (text.length > TIER_DESCRIPTION_MAX)
    throw new MembershipTierInvalidError('description_too_long');
  return text;
}
