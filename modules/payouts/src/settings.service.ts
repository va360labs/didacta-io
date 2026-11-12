/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsDbPort } from './accounts.service.js';
import { assertFeeBps } from './money.js';

/**
 * Comisión del operador por tenant (`mod_payouts_settings`).
 *
 * La fija el plano de control (Didacta Cloud) con su credencial de
 * aprovisionamiento; el creador no la edita. Sin fila, rige la comisión por
 * defecto de la instalación (`PAYMENTS_PLATFORM_DEFAULT_FEE_BPS`).
 */
export interface PayoutsSettingsView {
  readonly tenantId: string;
  readonly feeBps: number;
  /** `null` si el tenant nunca tuvo comisión propia (rige la de por defecto). */
  readonly updatedAt: string | null;
}

export class PayoutsSettingsService {
  constructor(
    private readonly db: PayoutsDbPort,
    private readonly defaultFeeBps: number,
  ) {}

  async get(tenantId: string): Promise<PayoutsSettingsView> {
    const row = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSettings.findUnique({ where: { tenantId } }),
    );
    return {
      tenantId,
      feeBps: row?.feeBps ?? this.defaultFeeBps,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /**
   * Fija la comisión. Idempotente: repetir el mismo valor no escribe (ni
   * mueve `updatedAt`), igual que la puerta de suscripción del contrato.
   */
  async setFeeBps(
    tenantId: string,
    feeBps: number,
    updatedBy: string,
  ): Promise<PayoutsSettingsView & { readonly changed: boolean; readonly previousFeeBps: number }> {
    assertFeeBps(feeBps);
    return this.db.inTenant(tenantId, async (tx) => {
      const existing = await tx.modPayoutsSettings.findUnique({ where: { tenantId } });
      const previousFeeBps = existing?.feeBps ?? this.defaultFeeBps;
      if (existing && existing.feeBps === feeBps) {
        return {
          tenantId,
          feeBps,
          updatedAt: existing.updatedAt.toISOString(),
          changed: false,
          previousFeeBps,
        };
      }
      const row = await tx.modPayoutsSettings.upsert({
        where: { tenantId },
        create: { tenantId, feeBps, updatedBy },
        update: { feeBps, updatedBy },
      });
      return {
        tenantId,
        feeBps: row.feeBps,
        updatedAt: row.updatedAt.toISOString(),
        changed: true,
        previousFeeBps,
      };
    });
  }

  /** Deuda abierta por divisa (unidad mínima). En E2 aún no se crean deudas. */
  async debtOutstanding(tenantId: string): Promise<Array<{ currency: string; amount: number }>> {
    const rows = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsDebt.groupBy({
        by: ['currency'],
        where: { tenantId, status: 'OPEN' },
        _sum: { amountOutstanding: true },
        orderBy: { currency: 'asc' },
      }),
    );
    return rows
      .map((row) => ({ currency: row.currency, amount: Number(row._sum.amountOutstanding ?? 0) }))
      .filter((row) => row.amount !== 0);
  }
}
