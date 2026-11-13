/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FetchGoogleDriveClient,
  serviceAccountAssertion,
} from '../src/video/cloud/google-drive.client';
import {
  HlsDownloadError,
  openBunnyHls,
  parseMasterPlaylist,
  parseMediaPlaylist,
} from '../src/video/cloud/hls-download';

const GUID = '0f8e2c52-6a3e-4c1f-9d55-2b8c4f6c2a10';
const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=842x480
480p/video.m3u8
`;
const MEDIA_TS = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
video0.ts
#EXTINF:4.0,
video1.ts
#EXT-X-ENDLIST
`;

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of chunks) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

function fakeCdn(files: Record<string, string | Uint8Array | number>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const body = files[url.pathname];
    if (body === undefined) return new Response('no', { status: 404 });
    if (typeof body === 'number') return new Response('x', { status: body });
    return new Response(body as ConstructorParameters<typeof Response>[0], { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('HLS: playlists', () => {
  it('elige la variante de más ancho de banda', () => {
    const v = parseMasterPlaylist(MASTER);
    expect(v.map((x) => x.uri)).toEqual(['720p/video.m3u8', '480p/video.m3u8', '360p/video.m3u8']);
    expect(v[0]!.resolution).toBe('1280x720');
  });

  it('detecta cifrado y segmento de inicio fMP4', () => {
    expect(parseMediaPlaylist(MEDIA_TS)).toEqual({
      initUri: null,
      segments: ['video0.ts', 'video1.ts'],
      encrypted: false,
    });
    const enc = parseMediaPlaylist(`#EXT-X-KEY:METHOD=AES-128,URI="k"\nv0.ts`);
    expect(enc.encrypted).toBe(true);
    expect(parseMediaPlaylist(`#EXT-X-KEY:METHOD=NONE\nv0.ts`).encrypted).toBe(false);
    expect(parseMediaPlaylist(`#EXT-X-MAP:URI="init.mp4"\nv0.m4s`).initUri).toBe('init.mp4');
  });
});

describe('HLS: descarga desde el servidor', () => {
  it('concatena los segmentos de la mejor variante y firma CADA petición', async () => {
    const { fetchImpl, calls } = fakeCdn({
      [`/${GUID}/playlist.m3u8`]: MASTER,
      [`/${GUID}/720p/video.m3u8`]: MEDIA_TS,
      [`/${GUID}/720p/video0.ts`]: new Uint8Array([1, 2, 3]),
      [`/${GUID}/720p/video1.ts`]: new Uint8Array([4, 5]),
    });
    const src = await openBunnyHls({
      cdnHostname: 'vz-x.b-cdn.net',
      guid: GUID,
      tokenKey: 'clave',
      fetch: fetchImpl,
      now: () => 1_700_000_000_000,
    });
    expect(src.container).toBe('ts');
    expect(src.resolution).toBe('1280x720');
    expect([...(await collect(src.chunks))]).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c).toMatch(/\?token=HS256-[A-Za-z0-9_-]+&expires=1700000600$/);
    // Nunca pide el original ni el MP4 (bloqueados a propósito).
    expect(calls.some((c) => /original|play_\d+p\.mp4/.test(c))).toBe(false);
  });

  it('fMP4: antepone el segmento de inicio', async () => {
    const { fetchImpl } = fakeCdn({
      [`/${GUID}/playlist.m3u8`]: '#EXT-X-STREAM-INF:BANDWIDTH=1\nv/a.m3u8',
      [`/${GUID}/v/a.m3u8`]: '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns0.m4s',
      [`/${GUID}/v/init.mp4`]: new Uint8Array([9]),
      [`/${GUID}/v/s0.m4s`]: new Uint8Array([8]),
    });
    const src = await openBunnyHls({
      cdnHostname: 'h.b-cdn.net',
      guid: GUID,
      tokenKey: null,
      fetch: fetchImpl,
    });
    expect(src.container).toBe('fmp4');
    expect([...(await collect(src.chunks))]).toEqual([9, 8]);
  });

  it('cifrado: aborta (la copia no serviría)', async () => {
    const { fetchImpl } = fakeCdn({
      [`/${GUID}/playlist.m3u8`]: '#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8',
      [`/${GUID}/v.m3u8`]: '#EXT-X-KEY:METHOD=AES-128,URI="k"\ns.ts',
    });
    await expect(
      openBunnyHls({ cdnHostname: 'h.b-cdn.net', guid: GUID, tokenKey: null, fetch: fetchImpl }),
    ).rejects.toThrow(/cifrado/);
  });

  it('un 403 no se reintenta; un 500 sí', async () => {
    const forbidden = fakeCdn({ [`/${GUID}/playlist.m3u8`]: 403 });
    await expect(
      openBunnyHls({
        cdnHostname: 'h.b-cdn.net',
        guid: GUID,
        tokenKey: 'k',
        fetch: forbidden.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HlsDownloadError);
    expect(forbidden.calls).toHaveLength(1);

    let n = 0;
    const flaky = (async (input: string | URL) => {
      n++;
      if (n < 3) return new Response('x', { status: 500 });
      const p = new URL(String(input)).pathname;
      if (p.endsWith('playlist.m3u8')) return new Response('#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8');
      if (p.endsWith('v.m3u8')) return new Response('s.ts');
      return new Response(new Uint8Array([7]));
    }) as typeof fetch;
    const src = await openBunnyHls({
      cdnHostname: 'h.b-cdn.net',
      guid: GUID,
      tokenKey: null,
      fetch: flaky,
    });
    expect([...(await collect(src.chunks))]).toEqual([7]);
  });
});

describe('Google Drive con cuenta de servicio', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = {
    clientEmail: 'copias@p.iam.gserviceaccount.com',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    tokenUri: 'https://oauth2.googleapis.com/token',
  };

  it('el JWT va firmado RS256 con la clave de la cuenta y pide el alcance de Drive', () => {
    const jwt = serviceAccountAssertion(sa, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    const verify = createVerify('RSA-SHA256');
    verify.update(`${h}.${c}`);
    expect(verify.verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: sa.clientEmail,
      aud: sa.tokenUri,
      scope: 'https://www.googleapis.com/auth/drive',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  it('sube por trozos reanudables a la unidad compartida y confirma el tamaño', async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      size: number;
    }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      const size = init?.body instanceof Uint8Array ? init.body.byteLength : 0;
      requests.push({ url, method: init?.method ?? 'GET', headers, size });
      if (url === sa.tokenUri) return Response.json({ access_token: 'ya29.t', expires_in: 3600 });
      if (url.includes('uploadType=resumable')) {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.example/s1' },
        });
      }
      if (url === 'https://upload.example/s1') {
        const range = headers['content-range']!;
        if (range.endsWith('/*')) return new Response(null, { status: 308 });
        return Response.json({ id: 'drive-file-1', size: '9' });
      }
      return new Response('?', { status: 500 });
    }) as typeof fetch;

    const drive = new FetchGoogleDriveClient({
      serviceAccount: sa,
      fetch: fetchImpl,
      chunkBytes: 4,
    });
    async function* bytes() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5, 6, 7]);
      yield new Uint8Array([8, 9]);
    }
    const res = await drive.upload({
      name: 'DC_demo__x.ts',
      mimeType: 'video/mp2t',
      folderId: 'carpeta',
      appProperties: { didactaTenantId: 't' },
      chunks: bytes(),
    });
    expect(res).toEqual({ fileId: 'drive-file-1', bytes: 9 });
    const start = requests.find((r) => r.url.includes('uploadType=resumable'))!;
    expect(start.url).toContain('supportsAllDrives=true');
    expect(start.url).toContain('fields=id,size');
    expect(start.headers['authorization']).toBe('Bearer ya29.t');
    const puts = requests.filter((r) => r.url === 'https://upload.example/s1');
    expect(puts.map((p) => p.headers['content-range'])).toEqual([
      'bytes 0-3/*',
      'bytes 4-7/*',
      'bytes 8-8/9',
    ]);
    expect(puts.map((p) => p.size)).toEqual([4, 4, 1]);
  });

  it('si Drive dice que guardó otro tamaño, la copia NO cuenta', async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url === sa.tokenUri) return Response.json({ access_token: 't' });
      if (url.includes('uploadType=resumable')) {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.example/s2' },
        });
      }
      return Response.json({ id: 'f', size: '2' });
    }) as typeof fetch;
    const drive = new FetchGoogleDriveClient({ serviceAccount: sa, fetch: fetchImpl });
    async function* three() {
      yield new Uint8Array([1, 2, 3]);
    }
    await expect(
      drive.upload({
        name: 'x',
        mimeType: 'video/mp2t',
        folderId: 'c',
        appProperties: {},
        chunks: three(),
      }),
    ).rejects.toThrow(/2 bytes de 3/);
  });

  it('borrar lo que ya no existe no es un error; un 403 sí', async () => {
    let status = 404;
    const fetchImpl = (async (input: string | URL) => {
      if (String(input) === sa.tokenUri) return Response.json({ access_token: 't' });
      return new Response(null, { status });
    }) as typeof fetch;
    const drive = new FetchGoogleDriveClient({ serviceAccount: sa, fetch: fetchImpl });
    expect(await drive.deleteFile('x')).toBe('not_found');
    status = 204;
    expect(await drive.deleteFile('x')).toBe('deleted');
    status = 403;
    await expect(drive.deleteFile('x')).rejects.toThrow(/403/);
  });
});
