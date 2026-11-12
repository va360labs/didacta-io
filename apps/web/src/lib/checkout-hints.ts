/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lo que las páginas públicas de venta (catálogo, ficha de curso y `/unete`)
 * cuentan del pago según lo que diga el SERVIDOR. Las dos señales solo llegan
 * cuando la instalación cobra por la plataforma; sin ellas (Community, o un
 * servidor anterior) las páginas son las de siempre.
 */

/**
 * ¿Poner «Al pagar puedes verlo en tu moneda» bajo este precio? Solo si el
 * servidor lo afirma: el aula cobra por la plataforma y el precio está en la
 * moneda del creador, que es cuando el pago lo convierte solo.
 */
export function showLocalCurrencyNote(
  price: { readonly localCurrencyAtCheckout?: boolean } | null | undefined,
): boolean {
  return price?.localCurrencyAtCheckout === true;
}

/**
 * ¿Puede la página decir que se aplica un cupón al pagar? Sí, salvo que el
 * servidor diga que no (cobro por la plataforma: el pago no admite cupones).
 * Sin el campo, lo de siempre.
 */
export function couponsAtCheckout(page: { readonly couponsAtCheckout?: boolean }): boolean {
  return page.couponsAtCheckout !== false;
}
