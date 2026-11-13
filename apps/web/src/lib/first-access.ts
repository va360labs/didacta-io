/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Primer acceso: en qué orden van los dos asistentes bloqueantes.
 *
 *  · El de PERFIL (`/onboarding`): foto, nombre, idioma y avisos.
 *  · El de ACADEMIA (`/bienvenida`): en modo sencillo, el alta en 3
 *    preguntas; en el completo, el asistente de puesta en marcha.
 *
 * Lo decide una función pura para que el gate del shell y sus tests digan lo
 * mismo. Reglas:
 *
 *  1. Quien no administra solo tiene el de perfil.
 *  2. En MODO SENCILLO, quien lleva la academia empieza por su perfil, con el
 *     mismo paso que el alumno (decisión de producto del 13-nov): su foto y su
 *     nombre acompañan cada post de su comunidad, y la foto se puede dejar
 *     para luego, así que no frena a quien quiere vender rápido.
 *  3. En el modo completo, la academia va primero: ahí la foto es
 *     obligatoria y exigirla antes de dejarle tocar lo que ha comprado era un
 *     primer contacto pésimo.
 */
export type FirstAccessDoor = '/onboarding' | '/bienvenida';

export interface FirstAccessState {
  /** `tenant_admin` o `super_admin` del aula. */
  administra: boolean;
  /** El aula está en modo sencillo. */
  sencillo: boolean;
  /** `onboardingCompletedAt` del usuario tiene fecha. */
  perfilHecho: boolean;
  /** El asistente de academia está terminado (o no le toca). */
  academiaHecha: boolean;
}

/** A qué asistente toca ir ahora, o `null` si ya no queda ninguno. */
export function firstAccessDoor(s: FirstAccessState): FirstAccessDoor | null {
  if (!s.administra) return s.perfilHecho ? null : '/onboarding';
  if (s.sencillo) {
    if (!s.perfilHecho) return '/onboarding';
    return s.academiaHecha ? null : '/bienvenida';
  }
  if (!s.academiaHecha) return '/bienvenida';
  return s.perfilHecho ? null : '/onboarding';
}

const ADMIN_ROLES = ['tenant_admin', 'super_admin'];

export function administra(roles: readonly string[] | null | undefined): boolean {
  return (roles ?? []).some((r) => ADMIN_ROLES.includes(r));
}

/**
 * ¿El paso de perfil lo está haciendo quien LLEVA la academia (modo sencillo)?
 * Cambia los textos (se presenta a sus alumnos), el botón de la foto («Dejar
 * para luego») y a dónde sigue al terminar: a su academia.
 */
export function isCreatorProfile(
  roles: readonly string[] | null | undefined,
  sencillo: boolean | null,
): boolean {
  return sencillo === true && administra(roles);
}

/**
 * Destino al terminar el perfil si no hay otro pendiente (deep link). El
 * creador sigue hacia «Empieza aquí»: si aún no ha hecho el alta en 3
 * preguntas, el gate del shell lo lleva a ella; si ya la hizo, se queda ahí.
 */
export function afterProfilePath(creator: boolean): string {
  return creator ? '/empieza' : '/inicio';
}
