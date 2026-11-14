/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { SaleView } from '@didacta/mod-payouts';
import { z } from 'zod';

/**
 * «Ventas» con los datos de cada venta: el contrato con la web.
 *
 * Una venta es un cobro real a una persona: la compra de un curso (orden de
 * `mod.billing`, completada o devuelta) o una cuota cobrada de una suscripción
 * (factura pagada de `mod.subscriptions`). Si el aula cobra por la plataforma,
 * la venta lleva además su reparto (`mod.payouts`): comisión de la tarjeta, la
 * del operador, lo que le llega al creador y en qué está.
 */

/** Estados que entiende el creador (y por los que filtra). */
export const SALE_STATUSES = ['paid', 'held', 'transferred', 'refunded', 'disputed'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** `order:<uuid>` (compra de un curso) o `invoice:<uuid>` (cuota cobrada). */
export const SALE_ID =
  /^(order|invoice):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** `course:<uuid>` o `plan:<uuid>`. */
const PRODUCT = /^(course|plan):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Filtros de la lista y de la exportación (los mismos en las dos). */
export const salesFiltersSchema = z.object({
  /** Desde (incluido), instante ISO. */
  from: z.coerce.date().optional(),
  /** Hasta (excluido), instante ISO. */
  to: z.coerce.date().optional(),
  product: z.string().regex(PRODUCT).optional(),
  status: z.enum(SALE_STATUSES).optional(),
  /** Nombre, correo o producto. */
  q: z.string().trim().max(120).optional(),
});
export type SalesFilters = z.infer<typeof salesFiltersSchema>;

export const salesListQuerySchema = salesFiltersSchema.extend({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type SalesListQuery = z.infer<typeof salesListQuerySchema>;

export const SALES_EXPORT_FORMATS = ['csv', 'xlsx'] as const;
/** `sales`: una fila por venta. `buyers`: una por comprador y moneda. */
export const SALES_EXPORT_VIEWS = ['sales', 'buyers'] as const;

export const salesExportQuerySchema = salesFiltersSchema.extend({
  format: z.enum(SALES_EXPORT_FORMATS).default('csv'),
  view: z.enum(SALES_EXPORT_VIEWS).default('sales'),
});
export type SalesExportQuery = z.infer<typeof salesExportQuerySchema>;

export interface SaleBuyer {
  readonly userId: string | null;
  readonly name: string | null;
  /** El de su cuenta en el aula (con el que entra); si no hay cuenta, el del pago. */
  readonly email: string | null;
  /** El que escribió al pagar, si es distinto del de su cuenta. */
  readonly checkoutEmail: string | null;
  /** País de facturación (ISO alfa-2) que confirmó Stripe; `null` si no se sabe. */
  readonly country: string | null;
  /** La cuenta se eliminó: la venta se conserva (obligación contable). */
  readonly deleted: boolean;
}

export interface SaleProduct {
  readonly kind: 'course' | 'membership';
  /** `course:<uuid>` o `plan:<uuid>` (lo que acepta el filtro). */
  readonly ref: string | null;
  readonly title: string | null;
  /** Opción de compra con nombre («Avanzado»); `null` si es el precio único. */
  readonly option: string | null;
  /** Periodicidad en meses de una cuota; `null` en un pago único. */
  readonly intervalMonths: number | null;
}

export interface SaleReferral {
  readonly referrerUserId: string;
  readonly referrerName: string | null;
  readonly code: string | null;
  /** Comisión para quien invitó, en `commissionCurrency`. */
  readonly commission: number;
  readonly commissionCurrency: string;
  readonly commissionStatus: string;
}

/** El reparto de una venta cobrada por la plataforma. Importes en `currency`. */
export interface SaleSettlement {
  readonly currency: string | null;
  readonly gross: number | null;
  readonly cardFee: number | null;
  readonly platformFee: number | null;
  /** Lo que le queda al creador (`creatorReceives`); `null` mientras se calcula. */
  readonly net: number | null;
  readonly debtNetted: number;
  readonly refunded: number;
}

export interface SaleRow {
  readonly id: string;
  readonly kind: 'order' | 'subscription';
  /** Cuándo se cobró (ISO). */
  readonly at: string;
  readonly buyer: SaleBuyer;
  readonly product: SaleProduct;
  /** Lo que pagó el comprador, en SU moneda (unidad mínima de Stripe). */
  readonly amount: number;
  readonly currency: string;
  /** Descuento de un cupón (pago único), en `currency`. */
  readonly coupon: number | null;
  /** Saldo de referidos que usó para pagar, en `currency`. */
  readonly referralCredit: number | null;
  readonly referral: SaleReferral | null;
  /** Solo si cobra la plataforma. */
  readonly settlement: SaleSettlement | null;
  readonly status: SaleStatus;
  readonly refundState: 'none' | 'partial' | 'full';
  /** Id de la venta en `mod.payouts` (para reembolsar desde el panel). */
  readonly payoutSaleId: string | null;
}

export interface SalesProductOption {
  readonly ref: string;
  readonly kind: 'course' | 'membership';
  readonly title: string | null;
}

export interface SalesCurrencyTotal {
  readonly currency: string;
  readonly count: number;
  readonly amount: number;
}

export interface SalesPageView {
  readonly items: SaleRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** Lo filtrado, por moneda (nunca se suman monedas distintas). */
  readonly totals: SalesCurrencyTotal[];
  /** Productos que tienen ventas (para el filtro). */
  readonly products: SalesProductOption[];
  /** Cobros de plataforma: quién y cuánto se queda de comisión. */
  readonly platform: { readonly operatorName: string; readonly feeBps: number } | null;
}

export interface SaleEvent {
  readonly type:
    | 'paid'
    | 'transferred'
    | 'refunded'
    | 'dispute_opened'
    | 'dispute_won'
    | 'dispute_lost';
  readonly at: string;
  readonly amount: number | null;
  readonly currency: string | null;
}

export interface SaleDetailView {
  readonly sale: SaleRow;
  /** La venta tal como la ve «Tus ventas» (reembolsar, reclamación, cuándo llega). */
  readonly payout: SaleView | null;
  readonly events: SaleEvent[];
  /** Factura de Stripe de una cuota (la que recibe el alumno). */
  readonly hostedInvoiceUrl: string | null;
  /** Periodo que cubre una cuota. */
  readonly period: { readonly start: string; readonly end: string } | null;
  readonly platform: { readonly operatorName: string; readonly feeBps: number } | null;
}
