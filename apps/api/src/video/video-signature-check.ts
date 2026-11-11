/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { bunnyEmbedBaseUrl, signBunnyEmbedUrl } from './bunny-embed';
import type { SignatureCheckOutcome } from './video-protection-config.service';

/**
 * Comprobación REAL de la firma de vídeo: Didacta pide a Bunny el reproductor
 * de un vídeo del propio tenant dos veces —con la firma que le daría a un
 * alumno y sin firma— y mira qué contesta a cada una.
 *
 * Hacen falta las dos. Que la URL firmada cargue no prueba nada por sí solo:
 * mientras la autenticación por token esté apagada en Bunny, carga CUALQUIER
 * URL, también una firmada con una clave equivocada. La petición sin firma es
 * el control que dice si la primera está discriminando.
 *
 *  - `ok`: la firmada carga y la sin firmar no. Bunny exige token y la clave
 *    guardada es la buena: la protección está sirviendo.
 *  - `not_enforced`: cargan las dos. Bunny todavía no exige token, así que los
 *    vídeos siguen abiertos y la clave NO se ha podido validar. Tras activarlo
 *    en Bunny hay que volver a comprobar.
 *  - `rejected`: la firmada no carga. Bunny exige token y no acepta esta firma:
 *    la clave guardada no es la «Token authentication key» de esa librería (lo
 *    típico es haber pegado la API key), o la librería restringe los dominios
 *    y el del aula no está entre ellos.
 *  - `video_unavailable`: Bunny dice que ese vídeo no existe (borrado, o la
 *    librería no es esa).
 *  - `unreachable`: no se pudo hablar con Bunny (red, DNS, timeout, 5xx).
 *
 * El destino es fijo (`iframe.mediadelivery.net`) y la ruta sale de un library
 * ID y un GUID ya validados: no es un fetch a una URL que elija el admin.
 */

export interface SignatureProbe {
  /** Código HTTP, o null si no hubo respuesta. */
  status: number | null;
  /** La respuesta es el reproductor del vídeo (y no una página de error). */
  playable: boolean;
}

export interface SignatureCheckResult {
  outcome: SignatureCheckOutcome;
  signed: SignatureProbe;
  unsigned: SignatureProbe;
}

/** Bunny corta mucho antes; el reproductor es una página de unas decenas de KB. */
const MAX_BODY_CHARS = 512_000;

/**
 * ¿Es el reproductor o una página de error?
 *
 * No basta con el código HTTP: con la autenticación por token activa, Bunny
 * contesta a un embed sin firma válida con una página de error «403» servida
 * con HTTP 200. Lo que distingue al reproductor es que trae la lista de
 * reproducción del vídeo (`…/playlist.m3u8`); la página de error no trae
 * ninguna.
 */
export function looksLikeBunnyPlayer(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false;
  return /\.m3u8/i.test(body);
}

function classify(signed: SignatureProbe, unsigned: SignatureProbe): SignatureCheckOutcome {
  if (signed.status === null || signed.status >= 500) return 'unreachable';
  if (signed.playable) {
    // Sin respuesta del control no se sabe si Bunny está discriminando: mejor
    // «no se pudo comprobar» que un verde sin prueba.
    if (unsigned.status === null || unsigned.status >= 500) return 'unreachable';
    return unsigned.playable ? 'not_enforced' : 'ok';
  }
  if (signed.status === 404) return 'video_unavailable';
  return 'rejected';
}

export async function checkBunnySignature(opts: {
  libraryId: string;
  guid: string;
  tokenKey: string;
  /**
   * URL del aula del tenant. Se manda como `Referer`, igual que el navegador
   * de un alumno: una librería con «allowed domains» rechaza las peticiones
   * que no vienen de un dominio permitido, lleven o no una firma válida.
   */
  referer?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
}): Promise<SignatureCheckResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;

  const probe = async (url: string): Promise<SignatureProbe> => {
    try {
      const res = await doFetch(url, {
        method: 'GET',
        headers: {
          accept: 'text/html',
          'user-agent': 'Didacta-Video-Protection-Check',
          ...(opts.referer ? { referer: opts.referer } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.text().catch(() => '')).slice(0, MAX_BODY_CHARS);
      return { status: res.status, playable: looksLikeBunnyPlayer(res.status, body) };
    } catch {
      return { status: null, playable: false };
    }
  };

  const signedUrl = signBunnyEmbedUrl({
    libraryId: opts.libraryId,
    guid: opts.guid,
    tokenKey: opts.tokenKey,
    // Vida corta: esta URL solo se usa aquí y ahora.
    ttlSeconds: 120,
    now: opts.now,
  }).url;
  const unsignedUrl = bunnyEmbedBaseUrl(opts.libraryId, opts.guid);

  const [signed, unsigned] = await Promise.all([probe(signedUrl), probe(unsignedUrl)]);
  return { outcome: classify(signed, unsigned), signed, unsigned };
}
