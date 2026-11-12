/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lo que la reproducción de siempre (`VideoPlaybackService`) necesita saber de
 * la biblioteca de Didacta Cloud. Vive aparte para que `VideoModule` lo pueda
 * pedir con `@Optional()` sin importar nada del módulo de subida: sin
 * `BUNNY_STREAM_API_KEY` nadie lo provee y la reproducción es la de siempre.
 */
export const VIDEO_CLOUD_LIBRARY = Symbol('VIDEO_CLOUD_LIBRARY');

export type CloudPlayDecision =
  /** El vídeo no es de un aula de este tenant: no se firma. */
  | { kind: 'not_ours' }
  /** El aula ha llegado al tope de horas vistas del mes (antes de vender). */
  | { kind: 'watch_quota_exceeded' }
  | { kind: 'ok'; tokenKey: string };

export interface CloudVideoLibrary {
  readonly libraryId: string;
  resolvePlay(input: {
    tenantId: string;
    guid: string;
    /** Quien gestiona cursos ve sus vídeos aunque se haya llegado al tope. */
    isEditor: boolean;
  }): Promise<CloudPlayDecision>;
}
