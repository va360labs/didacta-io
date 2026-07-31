/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Clasificación de lo que alguien compra en una tienda externa.
 *
 * De esto depende si un acceso caduca o no, así que un error aquí se paga en
 * las dos direcciones: cortarle el acceso a quien lo compró para siempre, o
 * regalarlo eternamente a quien pagó un año.
 *
 * Las reglas son **configurables por tenant** a propósito: los nombres de
 * producto son del negocio de cada uno. Lo único genérico es el criterio.
 */

/** Qué clase de derecho de acceso genera una línea de pedido. */
export type EntitlementKind =
  /** Acceso permanente. No caduca nunca y ningún automatismo debe retirarlo. */
  | 'LIFETIME'
  /**
   * Recurrente gestionado por la pasarela: ella cobra y ella renueva.
   * Al alumno se le avisa de que «se renovará el …».
   */
  | 'SUBSCRIPTION'
  /**
   * Pago único con vigencia. Caduca igual que una suscripción, pero **nadie lo
   * renueva solo**: hay que volver a comprar.
   *
   * Existe porque un «Acceso ANUAL» puede venderse como producto `simple` en
   * WooCommerce, no una suscripción: la tienda no emitirá ningún aviso ni
   * cobrará de nuevo. Si se tratara como suscripción, esperaríamos una
   * renovación que no va a llegar; si se tratara como compra suelta, daría
   * acceso de por vida. Al alumno se le avisa de que «termina el …».
   */
  | 'TIMED'
  /** Compra suelta (un curso). Da acceso a lo suyo y no caduca. */
  | 'ONE_OFF'
  /** No es formación (hosting, servicios). Fuera del circuito de acceso. */
  | 'INFRA';

export interface EntitlementRule {
  /** Se prueba contra el nombre del producto, sin distinguir mayúsculas. */
  match: RegExp;
  kind: EntitlementKind;
  /** Solo para TIMED: cuántos meses dura el acceso desde la compra. */
  durationMonths?: number;
  /** Nota para el panel de admin: por qué existe esta regla. */
  note?: string;
}

export interface EntitlementRuleset {
  /**
   * Se evalúan EN ORDEN y gana la primera que matchea. El orden importa:
   * un «PRO LIFETIME» matchea tanto el patrón de lifetime como el de
   * suscripción PRO, y debe ganar lifetime.
   */
  rules: readonly EntitlementRule[];
  /**
   * Qué hacer cuando ninguna regla matchea. Por defecto, tratarlo como compra
   * suelta: es lo único que no puede quitarle el acceso a nadie por error.
   */
  fallback: EntitlementKind;
}

/**
 * Reglas por defecto, deliberadamente conservadoras: solo clasifican lo que se
 * puede deducir sin conocer el negocio. Todo lo demás cae en `ONE_OFF`, que es
 * el default seguro (no caduca → nadie pierde acceso por una mala inferencia).
 */
export const DEFAULT_RULESET: EntitlementRuleset = {
  rules: [
    {
      match: /lifetime|de por vida|para siempre/i,
      kind: 'LIFETIME',
      note: 'Acceso permanente por nombre de producto.',
    },
  ],
  fallback: 'ONE_OFF',
};

/** Tipos de producto de WooCommerce que SIEMPRE son recurrentes. */
const WOO_SUBSCRIPTION_TYPES = new Set(['subscription', 'variable-subscription']);

export interface ClassifyInput {
  productName: string;
  /** Tipo del producto en la tienda (`simple`, `subscription`, …), si se conoce. */
  productType?: string | null;
}

export interface Classification {
  kind: EntitlementKind;
  /** Meses de vigencia. Solo con `kind: 'TIMED'`. */
  durationMonths?: number;
  /** Qué decidió la clasificación, para poder auditarla desde el panel. */
  reason: string;
}

/**
 * Clasifica una línea de pedido.
 *
 * El orden es intencionado:
 *  1. Las reglas del tenant mandan sobre cualquier inferencia — son las que
 *     conocen el negocio.
 *  2. El tipo de producto de la tienda es la mejor señal automática que existe:
 *     si la pasarela dice que es recurrente, lo es.
 *  3. El fallback nunca caduca. Ante la duda, no quitamos acceso.
 */
export function classifyPurchase(
  input: ClassifyInput,
  ruleset: EntitlementRuleset = DEFAULT_RULESET,
): Classification {
  const name = (input.productName ?? '').trim();

  for (const rule of ruleset.rules) {
    if (rule.match.test(name)) {
      return {
        kind: rule.kind,
        ...(rule.kind === 'TIMED' && rule.durationMonths
          ? { durationMonths: rule.durationMonths }
          : {}),
        reason: rule.note ?? `Regla del tenant: ${rule.match}`,
      };
    }
  }

  if (input.productType && WOO_SUBSCRIPTION_TYPES.has(input.productType)) {
    return {
      kind: 'SUBSCRIPTION',
      reason: `La tienda declara el producto como "${input.productType}".`,
    };
  }

  return {
    kind: ruleset.fallback,
    reason: 'Ninguna regla coincide; se trata como compra suelta (no caduca).',
  };
}

/**
 * Fecha en la que expira un acceso `TIMED`, contada desde la compra.
 *
 * Usa aritmética de meses de calendario (no 30 días): comprar el 31 de enero un
 * acceso de un mes vence el 28 de febrero, no el 2 de marzo.
 */
export function timedExpiryFrom(purchasedAt: Date, months: number): Date {
  const d = new Date(purchasedAt.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Si el mes destino es más corto, `setUTCMonth` desborda al siguiente:
  // 31-ene +1 mes daría 3-mar. Se corrige al último día del mes esperado.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

/** ¿Este tipo de acceso puede caducar? */
export function expires(kind: EntitlementKind): boolean {
  return kind === 'SUBSCRIPTION' || kind === 'TIMED';
}

/** ¿Este tipo de acceso cuenta para el circuito de formación? */
export function grantsLearningAccess(kind: EntitlementKind): boolean {
  return kind !== 'INFRA';
}

/**
 * Clasificación de un pedido completo a partir de sus líneas.
 *
 * Gana el derecho más fuerte: un pedido con un lifetime y un curso suelto es un
 * lifetime. El orden refleja «cuánto acceso concede», no cuánto dura.
 */
const STRENGTH: Record<EntitlementKind, number> = {
  LIFETIME: 5,
  SUBSCRIPTION: 4,
  TIMED: 3,
  ONE_OFF: 2,
  INFRA: 1,
};

export function strongestKind(kinds: readonly EntitlementKind[]): EntitlementKind {
  if (kinds.length === 0) return 'ONE_OFF';
  return kinds.reduce((best, k) => (STRENGTH[k] > STRENGTH[best] ? k : best), kinds[0]!);
}

/** Etiquetas en español para la ficha del alumno. */
export const KIND_LABELS: Record<EntitlementKind, string> = {
  LIFETIME: 'Acceso permanente',
  SUBSCRIPTION: 'Suscripción',
  TIMED: 'Acceso con vigencia',
  ONE_OFF: 'Compra suelta',
  INFRA: 'Servicio (no formación)',
};
