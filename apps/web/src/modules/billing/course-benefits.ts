/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Qué promete el panel «Empieza este curso». Antes eran cuatro frases fijas
 * («Certificado verificable», «Acceso de por vida», «Comunidad y soporte»…)
 * se cumplieran o no en ese curso. Ahora cada una sale solo si es verdad:
 *
 *  - `lifetime`: el curso se vende con pago único (no solo dentro de la
 *    membresía, cuyo acceso dura lo que dure la suscripción).
 *  - `certificate`: el aula emite certificados (`mod.certificates` activo).
 *  - `community`: el aula tiene comunidad (`mod.community` activo).
 *  - `pace`: siempre (los cursos no tienen horario).
 *
 * Mientras no se sabe qué módulos tiene el aula (`null`), no se promete nada
 * que dependa de ellos: mejor aparecer un instante después que prometer de más.
 */
export type CourseBenefit = 'lifetime' | 'certificate' | 'pace' | 'community';

export function courseBenefits(input: {
  oneTimePurchase: boolean;
  activeModules: ReadonlySet<string> | null;
}): CourseBenefit[] {
  const out: CourseBenefit[] = [];
  if (input.oneTimePurchase) out.push('lifetime');
  if (input.activeModules?.has('mod.certificates')) out.push('certificate');
  out.push('pace');
  if (input.activeModules?.has('mod.community')) out.push('community');
  return out;
}
