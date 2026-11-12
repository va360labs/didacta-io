/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente de la API HTTP de Bunny Stream (`video.bunnycdn.com`) con la clave de
 * UNA biblioteca. Genérico: no sabe nada de aulas ni de cuotas.
 *
 * Cada llamada está contrastada con la especificación pública
 * (https://video.bunnycdn.com/openapi/bunnynet-video-api.public.json):
 *
 *  - `POST /library/{id}/collections`               → CollectionModel
 *  - `GET  /library/{id}/collections?search=…`       → paginado de colecciones
 *  - `POST /library/{id}/videos` {title, collectionId} → VideoModel
 *  - `GET  /library/{id}/videos/{guid}`             → VideoModel
 *  - `GET  /library/{id}/videos?collection=…&page&itemsPerPage` (10–1000)
 *  - `DELETE /library/{id}/videos/{guid}`
 *  - `POST /library/{id}/videos/{guid}/resolutions/cleanup?resolutionsToDelete=…&deleteMp4Files=true`
 *
 * Autenticación: cabecera `AccessKey`. Los errores no llevan nunca la clave.
 *
 * Porte ampliado del `BunnyStreamService` del aula de VA360 (crear, subir,
 * borrar): aquí la subida la hace el navegador por TUS, y el servidor solo
 * crea el vídeo, firma y consulta.
 */

/** Estado del vídeo en la API (`VideoModelStatus`). */
export const BUNNY_VIDEO_STATUS = {
  CREATED: 0,
  UPLOADED: 1,
  PROCESSING: 2,
  TRANSCODING: 3,
  FINISHED: 4,
  ERROR: 5,
  UPLOAD_FAILED: 6,
  JIT_SEGMENTING: 7,
  JIT_PLAYLISTS_CREATED: 8,
} as const;

export interface BunnyVideo {
  guid: string;
  title: string;
  status: number;
  /** Segundos. */
  length: number;
  /** Bytes que ocupan las versiones codificadas. */
  storageSize: number;
  /** Segundos vistos en total desde que existe. */
  totalWatchTime: number;
  /** `240p,360p,720p`. */
  availableResolutions: string | null;
  collectionId: string | null;
  thumbnailFileName: string | null;
  encodeProgress: number;
  width: number;
  height: number;
  /** `dateUploaded` en milisegundos, o null si no viene. */
  dateUploadedMs: number | null;
}

export interface BunnyCollection {
  guid: string;
  name: string;
}

export class BunnyApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    detail: string,
  ) {
    super(`Bunny Stream ${operation} falló (${status}): ${detail}`);
    this.name = 'BunnyApiError';
  }
}

/** Lo que necesita el resto del código. Los tests usan un doble en memoria. */
export interface BunnyStreamClient {
  readonly libraryId: string;
  listCollections(search: string): Promise<BunnyCollection[]>;
  createCollection(name: string): Promise<BunnyCollection>;
  createVideo(input: { title: string; collectionId: string | null }): Promise<BunnyVideo>;
  /** null si Bunny ya no lo tiene (404). */
  getVideo(guid: string): Promise<BunnyVideo | null>;
  listVideos(input: {
    collectionId: string;
    page: number;
    itemsPerPage: number;
  }): Promise<{ items: BunnyVideo[]; totalItems: number }>;
  /** Idempotente: borrar lo que ya no existe no es un error. */
  deleteVideo(guid: string): Promise<'deleted' | 'not_found'>;
  /** Borra esas resoluciones (HLS y, si las hubiera, MP4). */
  deleteResolutions(guid: string, resolutions: readonly string[]): Promise<void>;
}

type FetchLike = typeof fetch;

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Bunny manda las fechas sin zona (`2026-11-12T10:00:00`): son UTC. */
function parseBunnyDate(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function toBunnyVideo(raw: Record<string, unknown>): BunnyVideo {
  return {
    guid: String(raw['guid'] ?? '').toLowerCase(),
    title: String(raw['title'] ?? ''),
    status: num(raw['status'], -1),
    length: num(raw['length']),
    storageSize: num(raw['storageSize']),
    totalWatchTime: num(raw['totalWatchTime']),
    availableResolutions: str(raw['availableResolutions']),
    collectionId: str(raw['collectionId'])?.toLowerCase() ?? null,
    thumbnailFileName: str(raw['thumbnailFileName']),
    encodeProgress: num(raw['encodeProgress']),
    width: num(raw['width']),
    height: num(raw['height']),
    dateUploadedMs: parseBunnyDate(raw['dateUploaded']),
  };
}

export class FetchBunnyStreamClient implements BunnyStreamClient {
  constructor(
    private readonly opts: {
      apiKey: string;
      libraryId: string;
      baseUrl: string;
      fetch?: FetchLike;
      /** Tope por llamada. */
      timeoutMs?: number;
    },
  ) {}

  get libraryId(): string {
    return this.opts.libraryId;
  }

  async listCollections(search: string): Promise<BunnyCollection[]> {
    const qs = new URLSearchParams({ search, itemsPerPage: '100', page: '1' });
    const json = await this.call('GET', `/collections?${qs}`, 'list-collections');
    const items = Array.isArray((json as { items?: unknown }).items)
      ? ((json as { items: Array<Record<string, unknown>> }).items ?? [])
      : [];
    return items
      .map((c) => ({ guid: String(c['guid'] ?? '').toLowerCase(), name: String(c['name'] ?? '') }))
      .filter((c) => c.guid);
  }

  async createCollection(name: string): Promise<BunnyCollection> {
    const json = (await this.call('POST', '/collections', 'create-collection', { name })) as Record<
      string,
      unknown
    >;
    const guid = str(json['guid']);
    if (!guid) throw new BunnyApiError(200, 'create-collection', 'respuesta sin guid');
    return { guid: guid.toLowerCase(), name: String(json['name'] ?? name) };
  }

  async createVideo(input: { title: string; collectionId: string | null }): Promise<BunnyVideo> {
    const body: Record<string, unknown> = { title: input.title };
    if (input.collectionId) body['collectionId'] = input.collectionId;
    const json = (await this.call('POST', '/videos', 'create-video', body)) as Record<
      string,
      unknown
    >;
    const video = toBunnyVideo(json);
    if (!video.guid) throw new BunnyApiError(200, 'create-video', 'respuesta sin guid');
    return video;
  }

  async getVideo(guid: string): Promise<BunnyVideo | null> {
    const res = await this.raw('GET', `/videos/${encodeURIComponent(guid)}`);
    if (res.status === 404) return null;
    const json = await this.parse(res, 'get-video');
    return toBunnyVideo(json as Record<string, unknown>);
  }

  async listVideos(input: {
    collectionId: string;
    page: number;
    itemsPerPage: number;
  }): Promise<{ items: BunnyVideo[]; totalItems: number }> {
    const qs = new URLSearchParams({
      collection: input.collectionId,
      page: String(input.page),
      itemsPerPage: String(input.itemsPerPage),
      orderBy: 'date',
    });
    const json = (await this.call('GET', `/videos?${qs}`, 'list-videos')) as {
      items?: Array<Record<string, unknown>> | null;
      totalItems?: number;
    };
    return {
      items: (json.items ?? []).map(toBunnyVideo),
      totalItems: num(json.totalItems),
    };
  }

  async deleteVideo(guid: string): Promise<'deleted' | 'not_found'> {
    const res = await this.raw('DELETE', `/videos/${encodeURIComponent(guid)}`);
    if (res.status === 404) return 'not_found';
    await this.parse(res, 'delete-video');
    return 'deleted';
  }

  async deleteResolutions(guid: string, resolutions: readonly string[]): Promise<void> {
    if (resolutions.length === 0) return;
    const qs = new URLSearchParams({
      resolutionsToDelete: resolutions.join(','),
      deleteMp4Files: 'true',
    });
    await this.call(
      'POST',
      `/videos/${encodeURIComponent(guid)}/resolutions/cleanup?${qs}`,
      'delete-resolutions',
    );
  }

  private async call(
    method: string,
    path: string,
    operation: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await this.raw(method, path, body);
    return this.parse(res, operation);
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const doFetch = this.opts.fetch ?? fetch;
    const url = `${this.opts.baseUrl}/library/${this.opts.libraryId}${path}`;
    return doFetch(url, {
      method,
      headers: {
        AccessKey: this.opts.apiKey,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
  }

  private async parse(res: Response, operation: string): Promise<unknown> {
    const text = await res.text().catch(() => '');
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = {};
      }
    }
    const failed =
      !res.ok ||
      (typeof json === 'object' &&
        json !== null &&
        (json as { success?: unknown }).success === false);
    if (failed) {
      const message =
        typeof json === 'object' && json !== null
          ? String((json as { message?: unknown }).message ?? '').slice(0, 200)
          : '';
      throw new BunnyApiError(res.status, operation, message || 'sin detalle');
    }
    return json;
  }
}
