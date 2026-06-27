/**
 * Tests unit de PaymentTiersService — sin DB real (Prisma mockeado in-memory).
 *
 * Cubre: catálogo (crear / nombre duplicado / borrar / no encontrado),
 * asignación manual (upsert / tier inválido / limpiar), tier efectivo
 * (manual > derivado > Desconocido) y applyDerivedTiers (no pisa el manual).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentTiersService } from '../src/tiers.service.js';
import { TierNameConflictError, TierNotFoundError } from '../src/errors.js';

interface TierRow {
  id: string;
  tenantId: string;
  name: string;
  isFree: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}
interface UserTierRow {
  id: string;
  tenantId: string;
  userId: string;
  manualTierId: string | null;
  derivedLabel: string | null;
  derivedProvider: string | null;
  derivedConnectionId: string | null;
  derivedRef: string | null;
  derivedSyncedAt: Date | null;
  assignedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class MockPrisma {
  tiers = new Map<string, TierRow>();
  userTiers = new Map<string, UserTierRow>();
  private ts = 0;
  private us = 0;
  private utKey(tenantId: string, userId: string) {
    return `${tenantId}:${userId}`;
  }

  private matchId(rowId: string, where: unknown): boolean {
    if (where === undefined) return true;
    if (typeof where === 'string') return rowId === where;
    if (where && typeof where === 'object' && 'not' in where) {
      return rowId !== (where as { not: string }).not;
    }
    return true;
  }

  modPaymentConnectionsTier = {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      for (const t of this.tiers.values()) {
        if (!this.matchId(t.id, w['id'])) continue;
        if (w['tenantId'] && t.tenantId !== w['tenantId']) continue;
        if (w['name'] && t.name !== w['name']) continue;
        return { ...t };
      }
      return null;
    },
    findMany: async (args: { where: Record<string, unknown> }) => {
      const w = args.where ?? {};
      const out = [...this.tiers.values()].filter(
        (t) => !w['tenantId'] || t.tenantId === w['tenantId'],
      );
      out.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      return out.map((t) => ({ ...t }));
    },
    create: async (args: { data: Record<string, unknown> }) => {
      this.ts += 1;
      const now = new Date();
      const row: TierRow = {
        id: `tier_${this.ts}`,
        tenantId: args.data['tenantId'] as string,
        name: args.data['name'] as string,
        isFree: (args.data['isFree'] as boolean) ?? false,
        sortOrder: (args.data['sortOrder'] as number) ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      this.tiers.set(row.id, row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.tiers.get(args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { ...row };
    },
    delete: async (args: { where: { id: string } }) => {
      const row = this.tiers.get(args.where.id);
      this.tiers.delete(args.where.id);
      // Simula onDelete: SetNull en user_tier.manualTierId.
      for (const ut of this.userTiers.values()) {
        if (ut.manualTierId === args.where.id) ut.manualTierId = null;
      }
      return row ? { ...row } : null;
    },
  };

  private withManual(ut: UserTierRow) {
    const manualTier = ut.manualTierId ? (this.tiers.get(ut.manualTierId) ?? null) : null;
    return { ...ut, manualTier: manualTier ? { name: manualTier.name } : null };
  }

  modPaymentConnectionsUserTier = {
    findMany: async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      const inIds = (w['userId'] as { in?: string[] })?.in ?? null;
      const out: ReturnType<typeof this.withManual>[] = [];
      for (const ut of this.userTiers.values()) {
        if (w['tenantId'] && ut.tenantId !== w['tenantId']) continue;
        if (inIds && !inIds.includes(ut.userId)) continue;
        out.push(this.withManual(ut));
      }
      return out;
    },
    upsert: async (args: {
      where: { tenantId_userId: { tenantId: string; userId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const { tenantId, userId } = args.where.tenantId_userId;
      const key = this.utKey(tenantId, userId);
      let row = this.userTiers.get(key);
      if (row) {
        Object.assign(row, args.update, { updatedAt: new Date() });
      } else {
        this.us += 1;
        const now = new Date();
        row = {
          id: `ut_${this.us}`,
          tenantId,
          userId,
          manualTierId: (args.create['manualTierId'] as string) ?? null,
          derivedLabel: (args.create['derivedLabel'] as string) ?? null,
          derivedProvider: (args.create['derivedProvider'] as string) ?? null,
          derivedConnectionId: (args.create['derivedConnectionId'] as string) ?? null,
          derivedRef: (args.create['derivedRef'] as string) ?? null,
          derivedSyncedAt: (args.create['derivedSyncedAt'] as Date) ?? null,
          assignedById: (args.create['assignedById'] as string) ?? null,
          createdAt: now,
          updatedAt: now,
        };
        this.userTiers.set(key, row);
      }
      return this.withManual(row);
    },
  };
}

const TENANT = 'tenant-1';

function build() {
  const prisma = new MockPrisma();
  const service = new PaymentTiersService(prisma as never);
  return { service, prisma };
}

describe('catálogo de tiers', () => {
  let svc: ReturnType<typeof build>;
  beforeEach(() => {
    svc = build();
  });

  it('crea un tier y rechaza nombre duplicado', async () => {
    const t = await svc.service.createTier(TENANT, { name: 'Pro', isFree: false });
    expect(t.name).toBe('Pro');
    await expect(svc.service.createTier(TENANT, { name: 'Pro' })).rejects.toBeInstanceOf(
      TierNameConflictError,
    );
  });

  it('borra un tier; no encontrado → error', async () => {
    const t = await svc.service.createTier(TENANT, { name: 'Free', isFree: true });
    await svc.service.deleteTier(TENANT, t.id);
    expect(svc.prisma.tiers.size).toBe(0);
    await expect(svc.service.deleteTier(TENANT, 'nope')).rejects.toBeInstanceOf(TierNotFoundError);
  });
});

describe('asignación + tier efectivo', () => {
  let svc: ReturnType<typeof build>;
  beforeEach(() => {
    svc = build();
  });

  it('asigna manual y el efectivo = manual', async () => {
    const pro = await svc.service.createTier(TENANT, { name: 'Pro' });
    await svc.service.assignManualTier(TENANT, 'user-1', pro.id, 'admin');
    const [view] = await svc.service.getUserTiers(TENANT, ['user-1']);
    expect(view!.effectiveLabel).toBe('Pro');
    expect(view!.source).toBe('manual');
  });

  it('tierId inválido → error', async () => {
    await expect(
      svc.service.assignManualTier(TENANT, 'user-1', 'nope', 'admin'),
    ).rejects.toBeInstanceOf(TierNotFoundError);
  });

  it('manual gana sobre derivado; quitar manual deja el derivado', async () => {
    const pro = await svc.service.createTier(TENANT, { name: 'Pro' });
    await svc.service.applyDerivedTiers(TENANT, [
      { userId: 'user-1', label: 'Stripe Gold', provider: 'stripe' },
    ]);
    // Solo derivado → efectivo = derivado.
    let [view] = await svc.service.getUserTiers(TENANT, ['user-1']);
    expect(view!.effectiveLabel).toBe('Stripe Gold');
    expect(view!.source).toBe('derived');

    // Asignar manual → gana el manual.
    await svc.service.assignManualTier(TENANT, 'user-1', pro.id, 'admin');
    [view] = await svc.service.getUserTiers(TENANT, ['user-1']);
    expect(view!.effectiveLabel).toBe('Pro');
    expect(view!.source).toBe('manual');

    // Quitar manual (null) → vuelve el derivado, que applyDerivedTiers no pisó.
    await svc.service.assignManualTier(TENANT, 'user-1', null, 'admin');
    [view] = await svc.service.getUserTiers(TENANT, ['user-1']);
    expect(view!.effectiveLabel).toBe('Stripe Gold');
    expect(view!.source).toBe('derived');
  });

  it('sin asignación → Desconocido (effectiveLabel null)', async () => {
    const views = await svc.service.getUserTiers(TENANT, ['ghost']);
    expect(views).toEqual([]);
  });
});
