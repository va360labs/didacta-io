/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { BrowserContext } from '@playwright/test';

/**
 * Doble de Bunny Stream para la E2E de la subida de vídeo: la API de UNA
 * biblioteca (colecciones, vídeos, recorte de resoluciones) y el servidor TUS
 * al que sube el NAVEGADOR. La API habla con él cuando arranca con
 * `BUNNY_STREAM_API_BASE_URL` / `BUNNY_STREAM_TUS_ENDPOINT` apuntando aquí
 * (ver `scripts/e2e-env.sh`); nunca sale nada hacia Bunny.
 *
 * Comprueba de verdad lo que comprobaría Bunny: la `AccessKey` de la
 * biblioteca en la API y, en TUS, la firma `SHA256(library + apiKey +
 * expire + videoId)` que hace la API. La codificación NO avanza sola: el test
 * la termina con `finishEncoding()` cuando ha visto el estado «procesando».
 *
 * TUS va por https, como en Bunny: la CSP de la web solo deja conectar con
 * `'self' https:`, así que el navegador sube a `TUS_DOUBLE_ORIGIN` (un host
 * `.test`, que no existe en internet) y `routeTusToDouble` lo desvía aquí.
 */
export const TUS_DOUBLE_ORIGIN = 'https://tus.bunny-doble.test';

/** Desvía al doble lo que el navegador sube a `TUS_DOUBLE_ORIGIN`. */
export async function routeTusToDouble(ctx: BrowserContext, double: BunnyDouble): Promise<void> {
  await ctx.route(`${TUS_DOUBLE_ORIGIN}/**`, async (route) => {
    const url = route.request().url().replace(TUS_DOUBLE_ORIGIN, `http://127.0.0.1:${double.port}`);
    try {
      await route.fulfill({ response: await route.fetch({ url }) });
    } catch {
      // Subida cancelada o pestaña cerrada a mitad: no hay a quién contestar.
      await route.abort().catch(() => undefined);
    }
  });
}

export interface BunnyDoubleVideo {
  guid: string;
  title: string;
  collectionId: string | null;
  status: number;
  length: number;
  storageSize: number;
  availableResolutions: string | null;
  dateUploaded: string;
  /** Bytes recibidos por TUS. */
  received: number;
}

export interface BunnyDouble {
  port: number;
  libraryId: string;
  videos: Map<string, BunnyDoubleVideo>;
  collections: Map<string, { guid: string; name: string }>;
  /** Subidas TUS con firma válida y sin ella (para comprobar que la firma discrimina). */
  tus: { accepted: number; rejected: number };
  /** Marca el vídeo como codificado (estado 4) con la duración dada. */
  finishEncoding: (guid: string, lengthSeconds?: number) => void;
  close: () => Promise<void>;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Tus-Resumable, Upload-Length, Upload-Metadata, Upload-Offset, Content-Type, AuthorizationSignature, AuthorizationExpire, VideoId, LibraryId, X-HTTP-Method-Override, X-Requested-With',
  'Access-Control-Expose-Headers': 'Location, Upload-Offset, Upload-Length, Tus-Resumable',
};

export async function startBunnyDouble(
  opts: {
    port?: number;
    libraryId?: string;
    apiKey?: string;
    /** Bytes por segundo en el PATCH de TUS: lento para que se vea el progreso. */
    bytesPerSecond?: number;
  } = {},
): Promise<BunnyDouble> {
  const port = opts.port ?? Number(process.env.E2E_BUNNY_DOUBLE_PORT ?? 12112);
  const libraryId = opts.libraryId ?? process.env.BUNNY_STREAM_LIBRARY_ID ?? '990011';
  const apiKey = opts.apiKey ?? process.env.BUNNY_STREAM_API_KEY ?? '';
  const bps = opts.bytesPerSecond ?? 12 * 1024;
  const videos = new Map<string, BunnyDoubleVideo>();
  const collections = new Map<string, { guid: string; name: string }>();
  const uploads = new Map<string, { length: number; offset: number }>();
  const tus = { accepted: 0, rejected: 0 };

  const model = (v: BunnyDoubleVideo) => ({
    videoLibraryId: Number(libraryId),
    guid: v.guid,
    title: v.title,
    dateUploaded: v.dateUploaded,
    length: v.length,
    status: v.status,
    width: 320,
    height: 180,
    availableResolutions: v.availableResolutions,
    thumbnailCount: 1,
    encodeProgress: v.status === 4 ? 100 : 0,
    storageSize: v.storageSize,
    collectionId: v.collectionId,
    thumbnailFileName: 'thumbnail.jpg',
    totalWatchTime: 0,
  });

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    // ── TUS (lo llama el navegador) ──
    if (p === '/tusupload' && req.method === 'POST') {
      const expire = Number(req.headers['authorizationexpire']);
      const videoId = String(req.headers['videoid'] ?? '');
      const lib = String(req.headers['libraryid'] ?? '');
      const expected = createHash('sha256')
        .update(`${lib}${apiKey}${expire}${videoId}`)
        .digest('hex');
      const ok =
        lib === libraryId &&
        req.headers['authorizationsignature'] === expected &&
        expire > Date.now() / 1000 &&
        videos.has(videoId);
      if (!ok) {
        tus.rejected++;
        res.writeHead(401, CORS);
        return res.end('firma no válida');
      }
      tus.accepted++;
      uploads.set(videoId, { length: Number(req.headers['upload-length']), offset: 0 });
      res.writeHead(201, {
        ...CORS,
        // Relativa: tus-js-client la resuelve contra el endpoint (el host https).
        Location: `/tusupload/${videoId}`,
        'Tus-Resumable': '1.0.0',
      });
      return res.end();
    }
    const tusMatch = /^\/tusupload\/([0-9a-f-]{36})$/.exec(p);
    if (tusMatch) {
      const id = tusMatch[1]!;
      const up = uploads.get(id);
      if (!up) {
        res.writeHead(404, CORS);
        return res.end();
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          ...CORS,
          'Upload-Offset': String(up.offset),
          'Upload-Length': String(up.length),
          'Tus-Resumable': '1.0.0',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      if (req.method === 'PATCH') {
        if (Number(req.headers['upload-offset']) !== up.offset) {
          res.writeHead(409, CORS);
          return res.end();
        }
        try {
          for await (const chunk of req) {
            up.offset += (chunk as Buffer).length;
            await new Promise((r) => setTimeout(r, ((chunk as Buffer).length / bps) * 1000));
          }
        } catch {
          return;
        }
        const v = videos.get(id);
        if (v) {
          v.received = up.offset;
          // Subido: Bunny lo pasa a «uploaded» y empieza a codificar.
          if (up.offset >= up.length) v.status = 3;
        }
        res.writeHead(204, {
          ...CORS,
          'Upload-Offset': String(up.offset),
          'Tus-Resumable': '1.0.0',
        });
        return res.end();
      }
    }

    // ── API de la biblioteca (la llama la API de Didacta) ──
    const lib = /^\/library\/(\d+)(\/.*)$/.exec(p);
    if (lib) {
      if (lib[1] !== libraryId || req.headers['accesskey'] !== apiKey) {
        return json(res, 401, { success: false, message: 'auth' });
      }
      const rest = lib[2]!;
      if (rest === '/collections' && req.method === 'GET') {
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const items = [...collections.values()].filter((c) =>
          c.name.toLowerCase().includes(search),
        );
        return json(res, 200, {
          totalItems: items.length,
          currentPage: 1,
          itemsPerPage: 100,
          items,
        });
      }
      if (rest === '/collections' && req.method === 'POST') {
        const { name } = JSON.parse((await readBody(req)) || '{}') as { name: string };
        const c = { guid: randomUUID(), name };
        collections.set(c.guid, c);
        return json(res, 200, { videoLibraryId: Number(libraryId), ...c, videoCount: 0 });
      }
      if (rest === '/videos' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          title: string;
          collectionId?: string;
        };
        const v: BunnyDoubleVideo = {
          guid: randomUUID(),
          title: body.title,
          collectionId: body.collectionId ?? null,
          status: 0,
          length: 0,
          storageSize: 0,
          availableResolutions: null,
          dateUploaded: new Date().toISOString().replace('Z', ''),
          received: 0,
        };
        videos.set(v.guid, v);
        return json(res, 200, model(v));
      }
      if (rest === '/videos' && req.method === 'GET') {
        const col = url.searchParams.get('collection');
        const items = [...videos.values()].filter((v) => !col || v.collectionId === col).map(model);
        return json(res, 200, {
          totalItems: items.length,
          currentPage: 1,
          itemsPerPage: 1000,
          items,
        });
      }
      const vm = /^\/videos\/([0-9a-f-]{36})(\/resolutions\/cleanup)?$/.exec(rest);
      if (vm) {
        const v = videos.get(vm[1]!);
        if (vm[2] && req.method === 'POST') {
          const del = (url.searchParams.get('resolutionsToDelete') ?? '').split(',');
          if (v?.availableResolutions) {
            v.availableResolutions = v.availableResolutions
              .split(',')
              .filter((r) => !del.includes(r))
              .join(',');
          }
          return json(res, 200, { success: true, statusCode: 200 });
        }
        if (req.method === 'GET') return v ? json(res, 200, model(v)) : json(res, 404, {});
        if (req.method === 'DELETE') {
          return videos.delete(vm[1]!) ? json(res, 200, { success: true }) : json(res, 404, {});
        }
      }
    }
    json(res, 404, { message: 'no' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    port,
    libraryId,
    videos,
    collections,
    tus,
    finishEncoding(guid, lengthSeconds = 3) {
      const v = videos.get(guid);
      if (!v) throw new Error(`el doble no tiene el vídeo ${guid}`);
      v.status = 4;
      v.length = lengthSeconds;
      v.storageSize = 250_000;
      v.availableResolutions = '240p,360p,480p,720p,1080p';
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
