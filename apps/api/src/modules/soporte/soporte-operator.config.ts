/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Aviso al operador de la plataforma de cada ticket de soporte nuevo.
 *
 * Mismo patrón que los otros avisos de operador del despliegue
 * (`PAYMENTS_PLATFORM_OPERATOR_ALERT_EMAIL`, `VIDEO_CLOUD_OPERATOR_ALERT_EMAIL`):
 * una dirección en una variable de entorno y el SMTP GLOBAL del despliegue.
 *
 *  - Didacta Cloud (el pool): `SUPPORT_OPERATOR_ALERT_EMAIL=valen@va360labs.com`
 *    en el compose del servicio. Cada ticket nuevo de cualquier aula le llega
 *    en el momento.
 *  - Una instalación propia de Community: sin la variable no se manda nada a
 *    nadie de fuera del aula. Los tickets solo los ve su equipo.
 *
 * Una dirección mal escrita NO tumba el arranque (es un aviso, no el
 * producto): se deja en el log con nivel de error y el aviso queda apagado.
 */

export const SUPPORT_OPERATOR_ENV = {
  alertEmail: 'SUPPORT_OPERATOR_ALERT_EMAIL',
} as const;

export interface SupportOperatorConfig {
  /** A quién avisar; `null` = a nadie. */
  readonly alertEmail: string | null;
  /** Por qué no se avisa aunque la variable esté puesta (`null` si todo va bien). */
  readonly problem: string | null;
}

/** Misma comprobación que la de vídeo: algo@algo.algo, sin espacios. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function readSupportOperatorConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SupportOperatorConfig {
  const raw = (env[SUPPORT_OPERATOR_ENV.alertEmail] ?? '').trim();
  if (!raw) return { alertEmail: null, problem: null };
  if (!EMAIL_RE.test(raw)) {
    return {
      alertEmail: null,
      problem: `${SUPPORT_OPERATOR_ENV.alertEmail} no es un correo: no se avisará al operador de los tickets nuevos.`,
    };
  }
  return { alertEmail: raw, problem: null };
}
