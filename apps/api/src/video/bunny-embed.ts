/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';

/**
 * Helpers puros para las URLs de embed de Bunny Stream.
 *
 * El reproductor de Bunny (`iframe.mediadelivery.net/embed/{library}/{guid}`)
 * admite «embed view token authentication»: con la opción activada en la
 * librería, el iframe solo carga si la URL trae `token` + `expires` firmados
 * con la clave privada de la librería. Una URL así caduca; una URL sin firmar
 * es permanente, y quien la ve una vez la conserva para siempre y puede
 * reproducirla (o descargarla) fuera del aula.
 *
 * Aquí no hay red ni estado: la firma es un cálculo local.
 */

export const BUNNY_EMBED_HOST = 'iframe.mediadelivery.net';

/** Library ID de Bunny: solo dígitos. */
export const BUNNY_LIBRARY_ID_RE = /^\d{1,12}$/;

/**
 * GUID de un vídeo de Bunny. Se valida la FORMA (8-4-4-4-12 hexadecimal) y no
 * la versión del UUID: es un identificador de un tercero, no nuestro.
 */
export const BUNNY_GUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Patrón (sintaxis Postgres ARE y JS) que captura el library ID de una URL de
 * embed/play de Bunny dentro de cualquier texto (content de lección, HTML…).
 */
export const BUNNY_LIBRARY_IN_URL_PATTERN = 'mediadelivery\\.net/(?:embed|play)/([0-9]+)/';

/** Caducidad de una URL firmada para reproducir (el iframe se carga al momento). */
export const PLAY_URL_TTL_SECONDS = 30 * 60;

export function bunnyEmbedBaseUrl(libraryId: string, guid: string): string {
  return `https://${BUNNY_EMBED_HOST}/embed/${libraryId}/${guid}`;
}

/**
 * Token de Bunny: `SHA256_HEX(token_security_key + video_id + expiration)`,
 * con `expiration` en segundos UNIX (Bunny no admite milisegundos).
 */
export function bunnyEmbedToken(tokenKey: string, guid: string, expiresUnix: number): string {
  return createHash('sha256').update(`${tokenKey}${guid}${expiresUnix}`).digest('hex');
}

export interface SignedPlayUrl {
  url: string;
  /** ISO de caducidad, o null si la URL no va firmada (librería sin clave). */
  expiresAt: string | null;
}

/**
 * URL de embed lista para el iframe. Sin `tokenKey` devuelve la URL sin firmar:
 * así actualizar no rompe nada mientras la clave no esté configurada (con la
 * autenticación por token apagada en Bunny, una URL sin token sigue cargando).
 */
export function signBunnyEmbedUrl(input: {
  libraryId: string;
  guid: string;
  tokenKey: string | null | undefined;
  ttlSeconds?: number;
  now?: Date;
}): SignedPlayUrl {
  const base = bunnyEmbedBaseUrl(input.libraryId, input.guid);
  if (!input.tokenKey) return { url: base, expiresAt: null };
  const nowMs = (input.now ?? new Date()).getTime();
  const expires = Math.floor(nowMs / 1000) + (input.ttlSeconds ?? PLAY_URL_TTL_SECONDS);
  const token = bunnyEmbedToken(input.tokenKey, input.guid, expires);
  return {
    url: `${base}?token=${token}&expires=${expires}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}
