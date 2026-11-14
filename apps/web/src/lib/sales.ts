/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Ventas» con los datos de cada venta (comprador, producto, cupón o referido,
 * comisiones, neto, estado y país), su detalle y la exportación.
 *
 * Backend: `apps/api/src/sales/sales-ledger.controller.ts`.
 *  - `GET /api/v1/admin/sales?page&pageSize&from&to&product&status&q`
 *  - `GET /api/v1/admin/sales/:id` (`order:<uuid>` o `invoice:<uuid>`)
 *  - `GET /api/v1/admin/sales/export?format=csv|xlsx&view=sales|buyers&…filtros`
 * Solo quien administra el aula (403 a cualquier otro rol).
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import type { PayoutsSaleDto } from './payouts';

export const SALE_STATUSES = ['paid', 'held', 'transferred', 'refunded', 'disputed'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export interface SaleBuyer {
  userId: string | null;
  name: string | null;
  email: string | null;
  checkoutEmail: string | null;
  country: string | null;
  deleted: boolean;
}

export interface SaleProduct {
  kind: 'course' | 'membership';
  ref: string | null;
  title: string | null;
  option: string | null;
  intervalMonths: number | null;
}

export interface SaleReferral {
  referrerUserId: string;
  referrerName: string | null;
  code: string | null;
  commission: number;
  commissionCurrency: string;
  commissionStatus: string;
}

export interface SaleSettlement {
  currency: string | null;
  gross: number | null;
  cardFee: number | null;
  platformFee: number | null;
  net: number | null;
  debtNetted: number;
  refunded: number;
}

export interface SaleRow {
  id: string;
  kind: 'order' | 'subscription';
  at: string;
  buyer: SaleBuyer;
  product: SaleProduct;
  amount: number;
  currency: string;
  coupon: number | null;
  referralCredit: number | null;
  referral: SaleReferral | null;
  settlement: SaleSettlement | null;
  status: SaleStatus;
  refundState: 'none' | 'partial' | 'full';
  payoutSaleId: string | null;
}

export interface SalesPage {
  items: SaleRow[];
  page: number;
  pageSize: number;
  total: number;
  totals: Array<{ currency: string; count: number; amount: number }>;
  products: Array<{ ref: string; kind: 'course' | 'membership'; title: string | null }>;
  platform: { operatorName: string; feeBps: number } | null;
}

export interface SaleEvent {
  type: 'paid' | 'transferred' | 'refunded' | 'dispute_opened' | 'dispute_won' | 'dispute_lost';
  at: string;
  amount: number | null;
  currency: string | null;
}

export interface SaleDetail {
  sale: SaleRow;
  payout: PayoutsSaleDto | null;
  events: SaleEvent[];
  hostedInvoiceUrl: string | null;
  period: { start: string; end: string } | null;
  platform: { operatorName: string; feeBps: number } | null;
}

export interface SalesFilters {
  /** `YYYY-MM-DD` (día local, incluido). */
  from?: string;
  /** `YYYY-MM-DD` (día local, incluido). */
  to?: string;
  product?: string;
  status?: SaleStatus | '';
  q?: string;
}

/** Día local `YYYY-MM-DD` → instante ISO de su comienzo (en la zona del navegador). */
function startOfLocalDay(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString();
}

/** Día local → instante ISO del comienzo del día SIGUIENTE (el «hasta» incluye el día). */
function endOfLocalDay(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).toISOString();
}

/** Los filtros como query string (sin los vacíos). Puro. */
export function salesQuery(
  filters: SalesFilters,
  extra: Record<string, string | number> = {},
): string {
  const params = new URLSearchParams();
  const from = filters.from ? startOfLocalDay(filters.from) : null;
  const to = filters.to ? endOfLocalDay(filters.to) : null;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (filters.product) params.set('product', filters.product);
  if (filters.status) params.set('status', filters.status);
  const q = filters.q?.trim();
  if (q) params.set('q', q.slice(0, 120));
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

/** Nombre del fichero que propone la API (`content-disposition`). */
export function fileNameFrom(header: string | null, fallback: string): string {
  const m = /filename="?([^";]+)"?/i.exec(header ?? '');
  return m?.[1] ?? fallback;
}

export const salesApi = {
  list(filters: SalesFilters, page: number, pageSize = 25): Promise<SalesPage> {
    return apiFetch<SalesPage>(
      `/api/v1/admin/sales${salesQuery(filters, { page, pageSize })}`,
      { method: 'GET' },
      withAuth(),
    );
  },
  detail(id: string): Promise<SaleDetail> {
    return apiFetch<SaleDetail>(
      `/api/v1/admin/sales/${encodeURIComponent(id)}`,
      { method: 'GET' },
      withAuth(),
    );
  },
  /** Descarga la exportación (con la sesión: no se puede enlazar a pelo). */
  async export(
    filters: SalesFilters,
    format: 'csv' | 'xlsx',
    view: 'sales' | 'buyers',
  ): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(`/api/v1/admin/sales/export${salesQuery(filters, { format, view })}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${withAuth()}` },
    });
    if (!res.ok) {
      throw new ApiHttpError({
        message: `No se pudo exportar (${res.status})`,
        status: res.status,
      });
    }
    return {
      blob: await res.blob(),
      fileName: fileNameFrom(res.headers.get('content-disposition'), `sales.${format}`),
    };
  },
};

/** Tono de la etiqueta de estado. */
export function saleStatusTone(
  sale: Pick<SaleRow, 'status' | 'refundState'>,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (sale.status) {
    case 'transferred':
      return 'success';
    case 'held':
      return 'warning';
    case 'disputed':
      return 'danger';
    case 'refunded':
      return 'neutral';
    case 'paid':
    default:
      return 'info';
  }
}

/** Clave del texto del estado (`modoSencilloVentas.datos.estado.*`). */
export function saleStatusKey(sale: Pick<SaleRow, 'status' | 'refundState'>): string {
  return sale.status === 'refunded' && sale.refundState === 'partial'
    ? 'refundedPartial'
    : sale.status;
}

/** `mailto:` para escribir al comprador, con el asunto ya puesto. */
export function mailtoBuyer(email: string, subject: string): string {
  return `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}`;
}
