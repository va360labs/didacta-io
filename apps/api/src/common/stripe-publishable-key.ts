/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Clave PUBLICABLE de Stripe (`pk_test_…` / `pk_live_…`): la que necesita el
 * navegador para pintar el pago embebido dentro de la ficha del aula.
 *
 * No es un secreto (va en el HTML de cualquier tienda), pero tiene que ser de
 * la MISMA cuenta y del MISMO modo que la clave secreta que crea la sesión: con
 * una de prueba y otra de producción, Stripe no encuentra la sesión y el
 * comprador ve un hueco. No se puede derivar de la secreta: la pone quien
 * configura la cuenta.
 */

const PUBLISHABLE_KEY = /^pk_(test|live)_[A-Za-z0-9]{8,255}$/;

/** `true` producción, `false` prueba, `null` si no es una clave publicable. */
export function publishableKeyLivemode(value: string | null | undefined): boolean | null {
  const match = value ? PUBLISHABLE_KEY.exec(value.trim()) : null;
  return match ? match[1] === 'live' : null;
}

/** Modo de una clave secreta o restringida (`sk_`/`rk_`), o `null`. */
export function secretKeyLivemode(value: string | null | undefined): boolean | null {
  const match = value ? /^(sk|rk)_(test|live)_/.exec(value.trim()) : null;
  return match ? match[2] === 'live' : null;
}

/**
 * Por qué una clave publicable NO vale para acompañar a esta secreta, o `null`
 * si vale: `format` (no es `pk_…`) o `mode` (prueba con producción o al revés).
 */
export function publishableKeyProblem(
  publishableKey: string,
  secretKey: string | null | undefined,
): 'format' | 'mode' | null {
  const pkLive = publishableKeyLivemode(publishableKey);
  if (pkLive === null) return 'format';
  const skLive = secretKeyLivemode(secretKey);
  if (skLive !== null && skLive !== pkLive) return 'mode';
  return null;
}
