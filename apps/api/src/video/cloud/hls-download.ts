/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { signBunnyCdnUrl } from './bunny-signing';

/**
 * Descarga, DESDE EL SERVIDOR, la versión de mayor calidad de un vídeo de Bunny
 * Stream para guardarla en la copia de Drive antes de borrar el vídeo.
 *
 * Por qué el HLS y no otra cosa:
 *  - El original no existe: la biblioteca de Cloud no lo guarda nunca.
 *  - Las URL directas están cerradas a propósito (regla `block_original`,
 *    `block_mp4` y el MP4 de reserva apagado): abrirlas para la copia
 *    reabriría el agujero por el que se bajaron el catálogo de VA360.
 *  - El HLS es lo que ya sirve la CDN, y con la autenticación por token de la
 *    CDN encendida solo se descarga con un token firmado con la clave de la
 *    biblioteca, que solo tiene el servidor. Cada petición va firmada para su
 *    ruta exacta y caduca en minutos.
 *
 * Se elige la variante de más ancho de banda y se concatenan sus segmentos
 * tal cual: unir los `.ts` de un mismo HLS da un MPEG-TS válido (lo abre VLC,
 * ffmpeg o el reproductor de Drive). Si los segmentos son fMP4 (con
 * `#EXT-X-MAP`) se antepone el segmento de inicio y sale un MP4 fragmentado.
 * Si el HLS va cifrado (`#EXT-X-KEY` distinto de NONE) se aborta: la copia no
 * serviría de nada.
 *
 * Todo en streaming: nunca se carga el vídeo entero en memoria.
 */

export class HlsDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlsDownloadError';
  }
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  resolution: string | null;
}

/** Variantes del playlist maestro, de más a menos ancho de banda. */
export function parseMasterPlaylist(text: string): HlsVariant[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
    const bw = /(?:^|,)BANDWIDTH=(\d+)/.exec(attrs);
    const res = /(?:^|,)RESOLUTION=(\d+x\d+)/.exec(attrs);
    let uri: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next) continue;
      if (next.startsWith('#')) continue;
      uri = next;
      break;
    }
    if (uri) out.push({ uri, bandwidth: bw ? Number(bw[1]) : 0, resolution: res?.[1] ?? null });
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth);
}

export interface MediaPlaylist {
  initUri: string | null;
  segments: string[];
  encrypted: boolean;
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let initUri: string | null = null;
  let encrypted = false;
  const segments: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY:')) {
      if (!/METHOD=NONE/.test(line)) encrypted = true;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) initUri = m[1]!;
      continue;
    }
    if (line.startsWith('#')) continue;
    segments.push(line);
  }
  return { initUri, segments, encrypted };
}

type FetchLike = typeof fetch;

export interface HlsSource {
  /** `fmp4` → `.mp4`; `ts` → `.ts`. */
  container: 'ts' | 'fmp4';
  resolution: string | null;
  segmentCount: number;
  /** Los bytes del vídeo, en orden. */
  chunks: AsyncIterable<Uint8Array>;
}

/**
 * Abre el HLS de un vídeo y devuelve su variante mejor. La descarga de
 * segmentos empieza al iterar `chunks`.
 */
export async function openBunnyHls(input: {
  cdnHostname: string;
  guid: string;
  /** Clave de firma de la CDN. Sin ella (autenticación de CDN apagada) no se firma. */
  tokenKey: string | null;
  fetch?: FetchLike;
  now?: () => number;
  /** Validez de cada URL firmada. */
  ttlSeconds?: number;
  /** Reintentos por segmento. */
  retries?: number;
}): Promise<HlsSource> {
  const doFetch = input.fetch ?? fetch;
  const now = input.now ?? (() => Date.now());
  const ttl = input.ttlSeconds ?? 600;
  const retries = input.retries ?? 3;
  const base = `https://${input.cdnHostname}/${input.guid}/`;

  const sign = (absolute: string): string =>
    input.tokenKey
      ? signBunnyCdnUrl({
          url: absolute,
          securityKey: input.tokenKey,
          expiresUnix: Math.floor(now() / 1000) + ttl,
        })
      : absolute;

  async function get(absolute: string): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(sign(absolute), {
          // El reproductor de Bunny pide la CDN con este Referer; si la
          // biblioteca restringe por dominio, es el que tiene permitido.
          headers: { referer: 'https://iframe.mediadelivery.net/' },
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) return res;
        // 4xx no se arregla reintentando (token, ruta o permiso).
        if (res.status >= 400 && res.status < 500) {
          throw new HlsDownloadError(
            `la CDN respondió ${res.status} a ${new URL(absolute).pathname}`,
          );
        }
        last = new HlsDownloadError(`la CDN respondió ${res.status}`);
      } catch (err) {
        if (err instanceof HlsDownloadError && /respondió 4\d\d/.test(err.message)) throw err;
        last = err;
      }
    }
    throw last instanceof Error ? last : new HlsDownloadError('descarga fallida');
  }

  const master = await (await get(`${base}playlist.m3u8`)).text();
  const variants = parseMasterPlaylist(master);
  if (variants.length === 0) throw new HlsDownloadError('el playlist no tiene variantes');
  const best = variants[0]!;
  const variantUrl = new URL(best.uri, base).toString();
  const media = parseMediaPlaylist(await (await get(variantUrl)).text());
  if (media.encrypted) throw new HlsDownloadError('el HLS va cifrado: la copia no serviría');
  if (media.segments.length === 0) throw new HlsDownloadError('la variante no tiene segmentos');

  const urls = [
    ...(media.initUri ? [new URL(media.initUri, variantUrl).toString()] : []),
    ...media.segments.map((s) => new URL(s, variantUrl).toString()),
  ];

  async function* chunks(): AsyncIterable<Uint8Array> {
    for (const url of urls) {
      const res = await get(url);
      if (!res.body) {
        yield new Uint8Array(await res.arrayBuffer());
        continue;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) yield value;
      }
    }
  }

  return {
    container: media.initUri ? 'fmp4' : 'ts',
    resolution: best.resolution,
    segmentCount: media.segments.length,
    chunks: chunks(),
  };
}
