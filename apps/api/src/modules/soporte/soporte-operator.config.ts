/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Aviso al operador de la plataforma de cada ticket que le escribe quien
 * administra un aula (destino PLATAFORMA). Lo que escriben los alumnos va a la
 * bandeja de su aula y no llega aquí.
 *
 * Mismo patrón que los otros avisos de operador del despliegue
 * (`PAYMENTS_PLATFORM_OPERATOR_ALERT_EMAIL`, `VIDEO_CLOUD_OPERATOR_ALERT_EMAIL`):
 * una dirección en una variable de entorno y el SMTP GLOBAL del despliegue.
 *
 *  - Didacta Cloud (el pool): `SUPPORT_OPERATOR_ALERT_EMAIL=valen@va360labs.com`
 *    en el compose del servicio. Cada ticket de un creador le llega en el
 *    momento, con Reply-To del creador para contestar por correo.
 *  - Una instalación propia de Community: sin la variable quien administra no
 *    tiene a quién escribir (la web no le enseña el botón) y los tickets de
 *    los alumnos solo los ve el equipo del aula.
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
      problem: `${SUPPORT_OPERATOR_ENV.alertEmail} no es un correo: los creadores no tendrán a quién escribir.`,
    };
  }
  return { alertEmail: raw, problem: null };
}
