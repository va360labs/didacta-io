/**
 * PaymentTiersService — tiers (planes de suscripción) por usuario.
 *
 * Dos fuentes del tier de un usuario:
 *   - manual: el admin lo asigna desde un catálogo gestionado por el tenant
 *     (incluye un tier "Free" para usuarios gratuitos).
 *   - derivado: el nombre del producto/suscripción que el usuario tiene en una
 *     cuenta de pago conectada (Stripe / PayPal / WooCommerce…), poblado por el
 *     botón "Sincronizar desde pagos".
 *
 * Tier EFECTIVO mostrado en /admin/usuarios = manual si existe, si no el
 * derivado, si no "Desconocido". El modelo es multi-proveedor (derivedProvider)
 * para que WooCommerce/WP Subscriptions encaje sin rediseño.
 */

import type { PrismaClient } from '@didacta/database';
import { TierNameConflictError, TierNotFoundError } from './errors.js';

type TierRow = Awaited<ReturnType<PrismaClient['modPaymentConnectionsTier']['create']>>;

export interface UserTierView {
  userId: string;
  /** Tier a mostrar; null → "Desconocido" en la UI. */
  effectiveLabel: string | null;
  source: 'manual' | 'derived' | null;
  manualTierId: string | null;
  manualTierName: string | null;
  derivedLabel: string | null;
  derivedProvider: string | null;
}

/** Una asignación de tier derivada de un pago (la produce el sync). */
export interface DerivedTierEntry {
  userId: string;
  label: string;
  provider: string;
  connectionId?: string | null;
  ref?: string | null;
}

export interface CreateTierInput {
  name: string;
  isFree?: boolean;
  sortOrder?: number;
}

export interface UpdateTierInput {
  name?: string;
  isFree?: boolean;
  sortOrder?: number;
}

export class PaymentTiersService {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------------- Catálogo (admin) ----------------

  async listCatalog(tenantId: string): Promise<TierRow[]> {
    return this.prisma.modPaymentConnectionsTier.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createTier(tenantId: string, input: CreateTierInput): Promise<TierRow> {
    const name = input.name.trim();
    const existing = await this.prisma.modPaymentConnectionsTier.findFirst({
      where: { tenantId, name },
    });
    if (existing) throw new TierNameConflictError(name);
    return this.prisma.modPaymentConnectionsTier.create({
      data: {
        tenantId,
        name,
        isFree: input.isFree ?? false,
        sortOrder: input.sortOrder ?? 0,
      },
    });
  }

  async updateTier(tenantId: string, id: string, input: UpdateTierInput): Promise<TierRow> {
    const tier = await this.prisma.modPaymentConnectionsTier.findFirst({
      where: { id, tenantId },
    });
    if (!tier) throw new TierNotFoundError(id);
    if (input.name !== undefined) {
      const name = input.name.trim();
      const clash = await this.prisma.modPaymentConnectionsTier.findFirst({
        where: { tenantId, name, id: { not: id } },
      });
      if (clash) throw new TierNameConflictError(name);
    }
    return this.prisma.modPaymentConnectionsTier.update({
      where: { id: tier.id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.isFree !== undefined ? { isFree: input.isFree } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
  }

  async deleteTier(tenantId: string, id: string): Promise<void> {
    const tier = await this.prisma.modPaymentConnectionsTier.findFirst({
      where: { id, tenantId },
    });
    if (!tier) throw new TierNotFoundError(id);
    // onDelete: SetNull en user_tier.manualTierId → las asignaciones manuales
    // quedan sin tier (vuelven al derivado/Desconocido), no se borran.
    await this.prisma.modPaymentConnectionsTier.delete({ where: { id: tier.id } });
  }

  // ---------------- Tiers de usuario ----------------

  /** Tier efectivo (batch) para un conjunto de usuarios — lo usa /admin/usuarios. */
  async getUserTiers(tenantId: string, userIds: string[]): Promise<UserTierView[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.modPaymentConnectionsUserTier.findMany({
      where: { tenantId, userId: { in: userIds } },
      include: { manualTier: true },
    });
    return rows.map((r) => toView(r));
  }

  /** Asigna (o limpia con tierId=null) el tier manual de un usuario. */
  async assignManualTier(
    tenantId: string,
    userId: string,
    tierId: string | null,
    actorId: string | null,
  ): Promise<UserTierView> {
    if (tierId) {
      const tier = await this.prisma.modPaymentConnectionsTier.findFirst({
        where: { id: tierId, tenantId },
      });
      if (!tier) throw new TierNotFoundError(tierId);
    }
    const row = await this.prisma.modPaymentConnectionsUserTier.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, manualTierId: tierId, assignedById: actorId },
      update: { manualTierId: tierId, assignedById: actorId },
      include: { manualTier: true },
    });
    return toView(row);
  }

  // ---------------- Derivado (sync desde pagos · Inc.B/C) ----------------

  /**
   * Upserta el tier DERIVADO de un conjunto de usuarios (no toca el manual).
   * `entries` viene de reconciliar las cuentas conectadas: cada usuario de
   * Didacta con una suscripción activa recibe el nombre de su producto/plan.
   */
  async applyDerivedTiers(
    tenantId: string,
    entries: DerivedTierEntry[],
  ): Promise<{ updated: number }> {
    let updated = 0;
    for (const e of entries) {
      await this.prisma.modPaymentConnectionsUserTier.upsert({
        where: { tenantId_userId: { tenantId, userId: e.userId } },
        create: {
          tenantId,
          userId: e.userId,
          derivedLabel: e.label,
          derivedProvider: e.provider,
          derivedConnectionId: e.connectionId ?? null,
          derivedRef: e.ref ?? null,
          derivedSyncedAt: new Date(),
        },
        update: {
          derivedLabel: e.label,
          derivedProvider: e.provider,
          derivedConnectionId: e.connectionId ?? null,
          derivedRef: e.ref ?? null,
          derivedSyncedAt: new Date(),
        },
      });
      updated += 1;
    }
    return { updated };
  }
}

type UserTierRowWithManual = Awaited<
  ReturnType<PrismaClient['modPaymentConnectionsUserTier']['findFirst']>
> & { manualTier?: { name: string } | null };

function toView(r: NonNullable<UserTierRowWithManual>): UserTierView {
  const manualName = r.manualTier?.name ?? null;
  const effectiveLabel = manualName ?? r.derivedLabel ?? null;
  const source: UserTierView['source'] = manualName ? 'manual' : r.derivedLabel ? 'derived' : null;
  return {
    userId: r.userId,
    effectiveLabel,
    source,
    manualTierId: r.manualTierId,
    manualTierName: manualName,
    derivedLabel: r.derivedLabel,
    derivedProvider: r.derivedProvider,
  };
}
