/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { authStorage } from './auth-storage';
import { administra } from './first-access';
import { simpleModeApi, simpleModeNow, type StartHereView } from './simple-mode';

/**
 * Adónde aterriza quien entra al aula sin un destino concreto: `/home`, que es
 * a donde van el login (contraseña, MFA, SSO), la portada con sesión y el
 * final de los asistentes.
 *
 * Hasta ahora `/home` llevaba SIEMPRE a la comunidad. En la primera venta real
 * de Didacta Cloud (14-nov-2026) el administrador de un aula en modo sencillo,
 * con la mitad de «Empieza aquí» por hacer, cayó en la comunidad y dio vueltas
 * hasta encontrar por dónde seguir. Reglas:
 *
 *  1. Quien administra un aula en modo sencillo con pasos de «Empieza aquí»
 *     pendientes → `/start`.
 *  2. Todo lo demás, como siempre → `/community`: alumnos y formadores, el
 *     modo completo, y el administrador que ya terminó sus pasos.
 *
 * Sin bucles: `/start` nunca devuelve a `/home` (a quien no administra lo
 * manda a la comunidad), y la comunidad no redirige.
 */
export type HomeLanding = '/start' | '/community';

export interface HomeLandingState {
  /** `tenant_admin` o `super_admin` del aula. */
  administra: boolean;
  /** El aula está en modo sencillo. */
  sencillo: boolean;
  /** Quedan pasos de «Empieza aquí» por hacer. */
  pasosPendientes: boolean;
}

export function landingPath(s: HomeLandingState): HomeLanding {
  return s.administra && s.sencillo && s.pasosPendientes ? '/start' : '/community';
}

/**
 * ¿Quedan pasos de «Empieza aquí»? Los mismos que cuenta la pestaña («3 de 6»)
 * y la propia pantalla: los que no están hechos.
 */
export function startHerePending(view: Pick<StartHereView, 'steps'>): boolean {
  return view.steps.some((s) => !s.done);
}

/**
 * Aplica `landingPath` con lo que se sabe en el navegador. Solo pregunta al
 * servidor lo imprescindible: el modo del aula (de la caché de la pestaña si
 * la hay) y, para un administrador en modo sencillo, su «Empieza aquí». Ante
 * cualquier fallo, la comunidad, que es el aterrizaje de siempre.
 */
export async function resolveHomeLanding(deps?: {
  roles?: readonly string[];
  simpleMode?: () => Promise<boolean>;
  startHere?: () => Promise<Pick<StartHereView, 'steps'>>;
}): Promise<HomeLanding> {
  const roles = deps?.roles ?? authStorage.getSession()?.user.roles ?? [];
  if (!administra(roles)) return '/community';
  try {
    const sencillo = await (deps?.simpleMode ?? simpleModeNow)();
    if (!sencillo) return '/community';
    const view = await (deps?.startHere ?? (() => simpleModeApi.startHere()))();
    return landingPath({ administra: true, sencillo, pasosPendientes: startHerePending(view) });
  } catch {
    return '/community';
  }
}
