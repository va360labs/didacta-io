/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsSummaryDto } from '@/lib/payouts';
import type { ReferralCommissionStatus } from '@/lib/referrals';

/** Resumen de una moneda tal como lo pinta «Ventas». Importes en unidad mínima. */
export interface SalesHeadline {
  currency: string;
  salesCount: number;
  gross: number;
  received: number;
  pending: number;
}

/**
 * La moneda que manda en el resumen: la que más ventas tiene (casi siempre la
 * única, la de liquidación del creador). `null` si aún no hay ninguna venta.
 */
export function primaryCurrency(summary: PayoutsSummaryDto | null): SalesHeadline | null {
  const rows = (summary?.currencies ?? []).filter((c) => c.salesCount > 0);
  if (rows.length === 0) return null;
  const best = rows.reduce((a, b) => (b.salesCount > a.salesCount ? b : a));
  return {
    currency: best.currency,
    salesCount: best.salesCount,
    gross: best.gross,
    received: best.received,
    pending: best.pending,
  };
}

/** Comisiones del programa de referidos que cuentan como venta traída (no anuladas). */
export function referralSales(
  rows: ReadonlyArray<{
    status: ReferralCommissionStatus;
    baseAmountCents: number;
    currency: string;
  }>,
): { count: number; byCurrency: Array<{ currency: string; base: number }> } {
  const valid = rows.filter((r) => r.status !== 'REVOKED');
  const map = new Map<string, number>();
  for (const r of valid) map.set(r.currency, (map.get(r.currency) ?? 0) + r.baseAmountCents);
  return {
    count: valid.length,
    byCurrency: Array.from(map, ([currency, base]) => ({ currency, base })),
  };
}

/** «10» o «12,5» (porcentaje) → puntos básicos; `null` si no es un % entre 0 y 100. */
export function percentToBps(raw: string): number | null {
  const n = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** Puntos básicos → texto del campo de %: 1000 → «10», 1250 → «12,5». */
export function bpsToPercentInput(bps: number): string {
  const n = bps / 100;
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}
