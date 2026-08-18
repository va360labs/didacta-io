'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Mis compras hechas en la tienda EXTERNA del centro.
 *
 * - GET /api/v1/me/purchases → los pedidos que la tienda dejó en mi perfil
 *
 * No es facturación de Didacta y no hay que confundirlo con `mod.subscriptions`
 * ni con `mod.billing`: aquí no se ha cobrado nada, se ha ANOTADO lo que cobró
 * otro. Didacta no emite ningún documento; de la factura solo se guarda su
 * número, su fecha y el enlace al PDF que sirve quien la emitió.
 *
 * En una instalación donde nadie venda desde fuera esto devuelve una lista
 * vacía siempre, y por eso la pestaña que lo pinta no se enseña si no hay nada.
 */

import { apiFetch } from '@/lib/api-client';

/** Una línea del pedido, tal y como se vendió. */
export interface PurchaseLine {
  name: string;
  quantity: number;
  amountCents: number;
  courseId?: string;
}

export interface Purchase {
  id: string;
  /** Quién vendió: `va360.academy`. */
  source: string;
  /** Número de pedido en la tienda. NO es un número de factura. */
  reference: string;
  /** PAID | REFUNDED | PARTIALLY_REFUNDED | CANCELLED. */
  status: string;
  amountCents: number;
  currency: string;
  lines: PurchaseLine[];
  /** Null mientras la tienda no la haya emitido, que es lo normal al principio. */
  invoice: { number: string; issuedAt: string | null; url: string | null } | null;
  orderUrl: string | null;
  placedAt: string;
  refundedAt: string | null;
  linkedToUser: boolean;
}

export interface MyPurchases {
  known: boolean;
  userId: string | null;
  orders: Purchase[];
}

export const myPurchasesApi = {
  list(token: string): Promise<MyPurchases> {
    return apiFetch<MyPurchases>('/api/v1/me/purchases', {}, token);
  },
};
