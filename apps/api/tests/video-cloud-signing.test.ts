/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bunnyTusSignature,
  signBunnyCdnUrl,
  verifyBunnyWebhookSignature,
} from '../src/video/cloud/bunny-signing';

describe('firma TUS de Bunny', () => {
  it('es SHA256_HEX(library_id + api_key + expiration + video_id), tal cual la documenta Bunny', () => {
    const sig = bunnyTusSignature({
      libraryId: '133',
      apiKey: 'clave-de-api',
      expiresUnix: 1_798_761_600,
      videoId: '657bb740-a71b-4529-a012-528021c31a92',
    });
    const expected = createHash('sha256')
      .update('133clave-de-api1798761600657bb740-a71b-4529-a012-528021c31a92')
      .digest('hex');
    expect(sig).toBe(expected);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cambia con el vídeo: una firma no sirve para subir a otro vídeo (control)', () => {
    const base = { libraryId: '133', apiKey: 'k', expiresUnix: 1 };
    expect(bunnyTusSignature({ ...base, videoId: 'a' })).not.toBe(
      bunnyTusSignature({ ...base, videoId: 'b' }),
    );
  });
});

/**
 * Vectores sacados del repositorio oficial de Bunny
 * (BunnyWay/BunnyCDN.TokenAuthentication, nodejs/token.test.js) y de ejecutar
 * su `signUrl` con las mismas entradas.
 */
describe('URL de la CDN firmada (HS256)', () => {
  const KEY = 'SecurityKey';
  const EXPIRES = 1598024587;

  it('sin parámetros', () => {
    expect(
      signBunnyCdnUrl({
        url: 'https://token-tester.b-cdn.net/300kb.jpg',
        securityKey: KEY,
        expiresUnix: EXPIRES,
      }),
    ).toBe(
      'https://token-tester.b-cdn.net/300kb.jpg?token=HS256-o10JRWlsAItyAsdKS6jJKjabHN4FrFsplDHPV1idcX4&expires=1598024587',
    );
  });

  it('con ruta permitida (token de directorio)', () => {
    expect(
      signBunnyCdnUrl({
        url: 'https://token-tester.b-cdn.net/abc/300kb.jpg',
        securityKey: KEY,
        expiresUnix: EXPIRES,
        tokenPath: '/abc',
      }),
    ).toBe(
      'https://token-tester.b-cdn.net/abc/300kb.jpg?token=HS256-uVZvT3SbEoVKYJyDJgbcsDmSFf73cv-uNUVaJiKWpbQ&token_path=%2Fabc&expires=1598024587',
    );
  });

  it('con un parámetro que ya traía la URL', () => {
    expect(
      signBunnyCdnUrl({
        url: 'https://token-tester.b-cdn.net/300kb.jpg?v=123',
        securityKey: KEY,
        expiresUnix: EXPIRES,
      }),
    ).toBe(
      'https://token-tester.b-cdn.net/300kb.jpg?token=HS256-q6oRQr-5ccQ-piO1HSEQu1DVMy9UMppRxGlIQwoeM5Y&v=123&expires=1598024587',
    );
  });

  it('el playlist de un vídeo de Stream', () => {
    expect(
      signBunnyCdnUrl({
        url: 'https://vz-test.b-cdn.net/0f8e2c52-6a3e-4c1f-9d55-2b8c4f6c2a10/playlist.m3u8',
        securityKey: KEY,
        expiresUnix: EXPIRES,
      }),
    ).toBe(
      'https://vz-test.b-cdn.net/0f8e2c52-6a3e-4c1f-9d55-2b8c4f6c2a10/playlist.m3u8?token=HS256-kaBhZxrh90jpQZ5Oq6T5LXeSLNFOmqsI_BLN5V93IGM&expires=1598024587',
    );
  });

  it('otra clave da otro token (control)', () => {
    const a = signBunnyCdnUrl({ url: 'https://x.b-cdn.net/a', securityKey: 'k1', expiresUnix: 1 });
    const b = signBunnyCdnUrl({ url: 'https://x.b-cdn.net/a', securityKey: 'k2', expiresUnix: 1 });
    expect(a).not.toBe(b);
  });
});

describe('firma del webhook de Bunny', () => {
  const secret = 'clave-de-solo-lectura';
  const body = Buffer.from(
    '{"VideoLibraryId":133,"VideoGuid":"657bb740-a71b-4529-a012-528021c31a92","Status":3}',
  );
  const good = createHmac('sha256', secret).update(body).digest('hex');
  const ok = { rawBody: body, version: 'v1', algorithm: 'hmac-sha256', secret };

  it('acepta la firma correcta', () => {
    expect(verifyBunnyWebhookSignature({ ...ok, signature: good })).toBe(true);
  });

  it('acepta la firma en mayúsculas (hex no distingue)', () => {
    expect(verifyBunnyWebhookSignature({ ...ok, signature: good.toUpperCase() })).toBe(true);
  });

  it('rechaza un cuerpo tocado', () => {
    expect(
      verifyBunnyWebhookSignature({
        ...ok,
        rawBody: Buffer.from(body.toString().replace('3}', '4}')),
        signature: good,
      }),
    ).toBe(false);
  });

  it('rechaza otra clave, otra versión, otro algoritmo y la firma ausente', () => {
    expect(verifyBunnyWebhookSignature({ ...ok, secret: 'otra', signature: good })).toBe(false);
    expect(verifyBunnyWebhookSignature({ ...ok, version: 'v2', signature: good })).toBe(false);
    expect(verifyBunnyWebhookSignature({ ...ok, algorithm: 'sha1', signature: good })).toBe(false);
    expect(verifyBunnyWebhookSignature({ ...ok, signature: undefined })).toBe(false);
    expect(verifyBunnyWebhookSignature({ ...ok, signature: 'zz' })).toBe(false);
  });
});
