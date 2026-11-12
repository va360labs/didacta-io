/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VideoCloudConfigError,
  loadVideoCloudConfig,
  parseServiceAccount,
} from '../src/video/cloud/video-cloud.config';
import { VideoCloudModule } from '../src/video/cloud/video-cloud.module';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'copias@proyecto.iam.gserviceaccount.com',
  private_key: PEM,
  token_uri: 'https://oauth2.googleapis.com/token',
});

const BASE = {
  BUNNY_STREAM_API_KEY: 'api-key-de-la-biblioteca-0001',
  BUNNY_STREAM_LIBRARY_ID: '700900',
  BUNNY_STREAM_CDN_HOSTNAME: 'vz-1234abcd-567.b-cdn.net',
  BUNNY_STREAM_TOKEN_KEY: 'token-key-de-seguridad-0001',
  BUNNY_STREAM_WEBHOOK_SECRET: 'read-only-key-0001',
};

describe('configuración de la subida de vídeo', () => {
  it('sin BUNNY_STREAM_API_KEY está apagada y no mira nada más (aunque haya basura)', () => {
    expect(loadVideoCloudConfig({})).toEqual({ enabled: false });
    expect(
      loadVideoCloudConfig({
        BUNNY_STREAM_LIBRARY_ID: 'no-es-un-numero',
        BUNNY_STREAM_API_KEY: '  ',
      }),
    ).toEqual({ enabled: false });
  });

  it('apagada, el módulo no registra rutas ni proveedores', () => {
    const mod = VideoCloudModule.register({ enabled: false });
    expect(mod.controllers).toBeUndefined();
    expect(mod.providers).toBeUndefined();
    expect(mod.global).toBeUndefined();
  });

  it('con todo, encendida; sin Drive la copia queda en null (inactividad en seco)', () => {
    const cfg = loadVideoCloudConfig({
      ...BASE,
      BUNNY_STREAM_CDN_HOSTNAME: 'https://VZ-1234abcd-567.b-cdn.net/',
    });
    expect(cfg).toMatchObject({
      enabled: true,
      libraryId: '700900',
      cdnHostname: 'vz-1234abcd-567.b-cdn.net',
      apiBaseUrl: 'https://video.bunnycdn.com',
      tusEndpoint: 'https://video.bunnycdn.com/tusupload',
      drive: null,
      operatorAlertEmail: null,
    });
  });

  it('encendida, el módulo registra el webhook, las rutas del creador y las del operador', () => {
    const cfg = loadVideoCloudConfig(BASE);
    const mod = VideoCloudModule.register(cfg);
    expect(mod.global).toBe(true);
    expect((mod.controllers ?? []).map((c) => (c as { name: string }).name).sort()).toEqual([
      'AdminTenantsVideoController',
      'VideoBunnyWebhookController',
      'VideoUploadsController',
    ]);
  });

  it('a medias no arranca, y el error nombra la variable SIN enseñar su valor', () => {
    let error: unknown;
    try {
      loadVideoCloudConfig({
        BUNNY_STREAM_API_KEY: 'secreto-que-no-debe-salir',
        BUNNY_STREAM_LIBRARY_ID: 'abc',
        BUNNY_STREAM_TOKEN_KEY: 'secreto-que-no-debe-salir',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(VideoCloudConfigError);
    const msg = (error as Error).message;
    expect(msg).toContain('BUNNY_STREAM_LIBRARY_ID');
    expect(msg).toContain('BUNNY_STREAM_CDN_HOSTNAME');
    expect(msg).toContain('BUNNY_STREAM_WEBHOOK_SECRET');
    expect(msg).toContain('BUNNY_STREAM_TOKEN_KEY no puede ser la API key');
    expect(msg).not.toContain('secreto-que-no-debe-salir');
  });

  it('la clave del webhook no puede ser la de escritura', () => {
    expect(() =>
      loadVideoCloudConfig({ ...BASE, BUNNY_STREAM_WEBHOOK_SECRET: BASE.BUNNY_STREAM_API_KEY }),
    ).toThrow(/SOLO LECTURA/);
  });

  it('Drive: acepta el JSON tal cual o en base64', () => {
    const plain = loadVideoCloudConfig({
      ...BASE,
      GOOGLE_DRIVE_BACKUP_SA_JSON: SA_JSON,
      GOOGLE_DRIVE_BACKUP_FOLDER_ID: '1AbCdEfGhIjKlMnOp',
    });
    const b64 = loadVideoCloudConfig({
      ...BASE,
      GOOGLE_DRIVE_BACKUP_SA_JSON: Buffer.from(SA_JSON).toString('base64'),
      GOOGLE_DRIVE_BACKUP_FOLDER_ID: '1AbCdEfGhIjKlMnOp',
    });
    for (const cfg of [plain, b64]) {
      expect(cfg.enabled && cfg.drive?.folderId).toBe('1AbCdEfGhIjKlMnOp');
      expect(cfg.enabled && cfg.drive?.serviceAccount.clientEmail).toBe(
        'copias@proyecto.iam.gserviceaccount.com',
      );
    }
  });

  it('Drive: carpeta sin credencial, o credencial rota, no arranca', () => {
    expect(() =>
      loadVideoCloudConfig({ ...BASE, GOOGLE_DRIVE_BACKUP_FOLDER_ID: '1AbCdEfGhIjKlMnOp' }),
    ).toThrow(/GOOGLE_DRIVE_BACKUP_SA_JSON falta/);
    expect(() =>
      loadVideoCloudConfig({
        ...BASE,
        GOOGLE_DRIVE_BACKUP_SA_JSON: '{"type":"service_account"}',
        GOOGLE_DRIVE_BACKUP_FOLDER_ID: '1AbCdEfGhIjKlMnOp',
      }),
    ).toThrow(/client_email/);
  });

  it('parseServiceAccount rechaza otro tipo de credencial', () => {
    expect(() => parseServiceAccount(JSON.stringify({ type: 'authorized_user' }))).toThrow(
      /service_account/,
    );
  });
});
