/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Reglas PURAS de la oferta al darse de baja (sin base de datos ni Stripe):
 * la lista de motivos, los límites de la configuración, qué meses de pausa se
 * pueden ofrecer, la ventana de una pausa y cómo se aplica el descuento.
 *
 * Están aparte para poder probarlas con fechas fijas y para que la web y el
 * servicio digan exactamente lo mismo.
 */

/**
 * Motivos de baja, en el orden en que se enseñan. Son los mismos seis que la
 * encuesta por correo del aula de VA360 (`MOTIVOS_DE_BAJA`), con claves en
 * inglés: el día que esto llegue allí, los dos resúmenes hablan igual.
 */
export const EXIT_REASONS = [
  'too_expensive',
  'no_time',
  'not_expected',
  'learned_enough',
  'missing_topics',
  'other',
] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

export function isExitReason(value: unknown): value is ExitReason {
  return typeof value === 'string' && (EXIT_REASONS as readonly string[]).includes(value);
}

/** Texto libre del motivo: máximo de caracteres que se guardan. */
export const EXIT_REASON_TEXT_MAX = 500;

/** Límites de lo que la creadora puede configurar. */
export const RETENTION_LIMITS = {
  pauseMaxMonths: { min: 1, max: 3 },
  /** Hasta el 90 %: el 100 % es una pausa con acceso, y eso no se ofrece. */
  discountPercent: { min: 5, max: 90 },
  discountMonths: { min: 1, max: 12 },
} as const;

/** Configuración por defecto (aula sin fila): todo apagado. */
export const DEFAULT_RETENTION_CONFIG = {
  pauseEnabled: false,
  pauseMaxMonths: 3,
  discountEnabled: false,
  discountPercent: 30,
  discountMonths: 3,
} as const;

export interface RetentionConfigView {
  pauseEnabled: boolean;
  pauseMaxMonths: number;
  discountEnabled: boolean;
  discountPercent: number;
  discountMonths: number;
}

/** Una pausa por persona y aula cada tantos días. */
export const PAUSE_COOLDOWN_DAYS = 365;

/**
 * Margen al comparar fechas de Stripe con las nuestras (un webhook de la
 * renovación llega con `created` unos segundos o minutos después del fin del
 * periodo; la factura se finaliza hasta una hora después).
 */
export const PAUSE_TIME_SLACK_MS = 12 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Suma meses en UTC sin desbordar: 31 ene + 1 mes = 28 (o 29) feb, como hace
 * Stripe con los ciclos de facturación. `Date#setUTCMonth` daría 3 de marzo.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * Meses de pausa que se pueden ofrecer. La pausa salta cobros ENTEROS (Stripe
 * anula la factura de cada renovación): con un plan mensual vale cualquier
 * número de meses hasta el máximo; con uno trimestral, 3 (un cobro); con uno
 * anual, ninguno — pausar un año entero no es una pausa.
 */
export function pauseMonthOptions(intervalMonths: number | null, maxMonths: number): number[] {
  if (!intervalMonths || intervalMonths < 1) return [];
  const out: number[] = [];
  for (let m = intervalMonths; m <= maxMonths; m += intervalMonths) out.push(m);
  return out;
}

export interface PauseWindow {
  /** Fin del periodo ya pagado: aquí empieza la pausa (sin acceso). */
  startsAt: Date;
  /** Primer cobro tras la pausa: aquí vuelve el acceso (si el cobro entra). */
  endsAt: Date;
  /**
   * Cuándo deja Stripe de anular facturas: un día antes del primer cobro, para
   * que esa renovación ya se cobre aunque los relojes no casen al segundo.
   */
  resumesAt: Date;
}

export function pauseWindow(currentPeriodEnd: Date, months: number): PauseWindow {
  const endsAt = addMonthsUtc(currentPeriodEnd, months);
  return {
    startsAt: currentPeriodEnd,
    endsAt,
    resumesAt: new Date(endsAt.getTime() - DAY_MS),
  };
}

export type DiscountPlan =
  | { duration: 'repeating'; durationInMonths: number }
  | { duration: 'once'; durationInMonths: null };

/**
 * Cómo se aplica el descuento. Con plan mensual, un cupón `repeating` de N
 * meses: Stripe lo aplica a las facturas de los próximos N meses, que son N
 * cuotas porque la próxima renovación cae antes de un mes (verificado en
 * Stripe de prueba). Con un plan de periodo más largo, «N meses» no casa con
 * los cobros (un anual podría no renovar en esos meses): el descuento va a la
 * SIGUIENTE renovación (`once`).
 */
export function discountPlan(intervalMonths: number | null, months: number): DiscountPlan {
  if (intervalMonths === 1) return { duration: 'repeating', durationInMonths: months };
  return { duration: 'once', durationInMonths: null };
}

/** Importe tras el descuento (redondeo al céntimo, como Stripe). */
export function discountedAmount(amountCents: number, percent: number): number {
  return Math.round((amountCents * (100 - percent)) / 100);
}

/** Valida y normaliza la configuración. Devuelve el nombre del campo malo o null. */
export function invalidRetentionField(input: Partial<RetentionConfigView>): string | null {
  const between = (v: number | undefined, lim: { min: number; max: number }) =>
    v === undefined || (Number.isInteger(v) && v >= lim.min && v <= lim.max);
  if (!between(input.pauseMaxMonths, RETENTION_LIMITS.pauseMaxMonths)) return 'pauseMaxMonths';
  if (!between(input.discountPercent, RETENTION_LIMITS.discountPercent)) return 'discountPercent';
  if (!between(input.discountMonths, RETENTION_LIMITS.discountMonths)) return 'discountMonths';
  return null;
}

/** Nombre del cupón (sale en la factura del alumno): neutro, sin idioma. */
export function retentionCouponName(percent: number, plan: DiscountPlan): string {
  return plan.duration === 'repeating'
    ? `-${percent}% · ${plan.durationInMonths}m`
    : `-${percent}%`;
}
