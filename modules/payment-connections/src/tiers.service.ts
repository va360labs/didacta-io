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

  /**
   * Catálogo + nº de usuarios cuyo tier EFECTIVO es cada tier: manual asignado a
   * ese tier, o (sin manual) derivado cuyo `derivedLabel` coincide con el nombre.
   * Lo usa el panel para mostrar "X usuarios" por tier.
   */
  async listCatalogWithCounts(tenantId: string): Promise<Array<TierRow & { memberCount: number }>> {
    const [tiers, userTiers] = await Promise.all([
      this.listCatalog(tenantId),
      this.prisma.modPaymentConnectionsUserTier.findMany({
        where: { tenantId },
        select: { manualTierId: true, derivedLabel: true },
      }),
    ]);
    return tiers.map((t) => ({
      ...t,
      memberCount: userTiers.filter(
        (ut) =>
          ut.manualTierId === t.id ||
          (ut.manualTierId == null && (ut.derivedLabel ?? null) === t.name),
      ).length,
    }));
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

  /**
   * Borra un tier y devuelve los usuarios cuyo tier EFECTIVO cambia por ello
   * (los que lo tenían manual, o lo tenían como derivado por nombre), para que el
   * caller emita `user_tier.changed` y el bridge reconcilie su membresía de grupo.
   */
  async deleteTier(tenantId: string, id: string): Promise<{ affectedUserIds: string[] }> {
    const tier = await this.prisma.modPaymentConnectionsTier.findFirst({
      where: { id, tenantId },
    });
    if (!tier) throw new TierNotFoundError(id);

    // Usuarios afectados ANTES de borrar: manual = este tier, o derivado por
    // nombre (sin manual) = el nombre de este tier.
    const affected = await this.prisma.modPaymentConnectionsUserTier.findMany({
      where: {
        tenantId,
        OR: [{ manualTierId: tier.id }, { manualTierId: null, derivedLabel: tier.name }],
      },
      select: { userId: true },
    });

    // onDelete: SetNull en user_tier.manualTierId → las asignaciones manuales
    // quedan sin tier (vuelven al derivado/Desconocido), no se borran.
    await this.prisma.modPaymentConnectionsTier.delete({ where: { id: tier.id } });

    return { affectedUserIds: [...new Set(affected.map((a) => a.userId))] };
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
    opts: { reconciledConnectionIds?: string[] } = {},
  ): Promise<{ updated: number; tiersCreated: number; clearedUserIds: string[] }> {
    // 1) Crear en el CATÁLOGO un tier por cada plan distinto que aún no exista,
    //    para que el sync "cree los tiers" visibles en el panel (no solo el
    //    derivedLabel por usuario). El admin luego puede renombrarlos/marcarlos free.
    const distinctLabels = [...new Set(entries.map((e) => e.label.trim()).filter(Boolean))];
    let tiersCreated = 0;
    for (const name of distinctLabels) {
      const existing = await this.prisma.modPaymentConnectionsTier.findFirst({
        where: { tenantId, name },
      });
      if (!existing) {
        await this.prisma.modPaymentConnectionsTier.create({
          data: { tenantId, name, isFree: false, sortOrder: 0 },
        });
        tiersCreated += 1;
      }
    }

    // 2) Asignar el tier DERIVADO a cada usuario con suscripción (no toca el manual).
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

    // 3) CHURN: usuarios que ANTES tenían un derivado de una de las conexiones
    //    reconciliadas en este sync y ya NO aparecen (cancelaron la suscripción).
    //    Limpiamos su derivado (sin tocar el manual) y los devolvemos para que el
    //    caller emita user_tier.changed → el bridge los saca del grupo vinculado.
    //    Acotado a `reconciledConnectionIds` para no tratar como churn a usuarios
    //    de una conexión que falló en este sync.
    const clearedUserIds: string[] = [];
    if (opts.reconciledConnectionIds && opts.reconciledConnectionIds.length > 0) {
      const entryUserIds = new Set(entries.map((e) => e.userId));
      const stale = await this.prisma.modPaymentConnectionsUserTier.findMany({
        where: {
          tenantId,
          derivedLabel: { not: null },
          derivedConnectionId: { in: opts.reconciledConnectionIds },
        },
        select: { userId: true },
      });
      for (const s of stale) {
        if (entryUserIds.has(s.userId)) continue; // sigue suscrito → no es churn
        await this.prisma.modPaymentConnectionsUserTier.update({
          where: { tenantId_userId: { tenantId, userId: s.userId } },
          data: {
            derivedLabel: null,
            derivedProvider: null,
            derivedConnectionId: null,
            derivedRef: null,
            derivedSyncedAt: new Date(),
          },
        });
        clearedUserIds.push(s.userId);
      }
    }

    return { updated, tiersCreated, clearedUserIds };
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
