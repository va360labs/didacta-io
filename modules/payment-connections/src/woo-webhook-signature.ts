/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifica la firma de un webhook de WooCommerce.
 *
 * Woo firma distinto que Stripe y que Zoom, y conviene tenerlo escrito porque
 * las diferencias son justo donde se cuelan los fallos:
 *
 *  - Header `x-wc-webhook-signature`, **sin prefijo** (Stripe usa `t=…,v1=…`,
 *    Zoom usa `v0=…`).
 *  - HMAC-SHA256 del cuerpo **crudo**, codificado en **base64** (no hex).
 *  - **No hay timestamp**, así que no se puede acotar la ventana de replay
 *    como en Zoom. La defensa contra reenvíos es la idempotencia por id de
 *    pedido: procesar dos veces el mismo pedido deja el mismo resultado.
 *
 * El HMAC va sobre el cuerpo tal y como llegó. Si se reserializa el JSON antes
 * de firmar, la firma no cuadra nunca — de ahí que el controller necesite el
 * `rawBody`.
 */
export function verifyWooSignature(opts: {
  signatureHeader: string | undefined;
  /**
   * Cuerpo **crudo**. Acepta Buffer y es lo que hay que pasarle siempre que se
   * tenga: convertirlo a string antes de firmar mete una conversión de bytes a
   * texto y vuelta, y cualquier byte que no sea UTF-8 válido se sustituye por
   * el carácter de reemplazo de forma irreversible. El HMAC deja de cuadrar y
   * el fallo solo aparece con pedidos que llevan acentos — nunca en una prueba
   * hecha con texto ASCII.
   */
  rawBody: string | Buffer;
  secret: string;
}): boolean {
  const { signatureHeader, rawBody, secret } = opts;
  if (!signatureHeader || !secret || !rawBody || rawBody.length === 0) return false;

  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected = createHmac('sha256', secret).update(bytes).digest('base64');

  // `timingSafeEqual` exige buffers del mismo tamaño; una longitud distinta ya
  // descarta la firma sin necesidad de comparar.
  const provided = signatureHeader.trim();
  if (provided.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/** Temas de WooCommerce que nos interesan. El resto se acepta y se ignora. */
export const WOO_ORDER_TOPICS = new Set(['order.created', 'order.updated', 'order.deleted']);
