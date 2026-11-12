/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createPrivateKey } from 'node:crypto';
import { BUNNY_LIBRARY_ID_RE } from '../bunny-embed';

/**
 * Configuración de la SUBIDA DE VÍDEO a Bunny Stream de Didacta Cloud
 * (variables `BUNNY_STREAM_*` y `GOOGLE_DRIVE_BACKUP_*`).
 *
 * El interruptor es `BUNNY_STREAM_API_KEY`:
 *
 *  - Sin ella (o vacía) la subida está APAGADA y el resto de variables ni se
 *    miran: la lección admite solo enlaces, como siempre, y la API tiene
 *    exactamente las mismas rutas que antes. Es el caso de toda Community.
 *  - Con ella la subida está ENCENDIDA y lo demás se valida de verdad. Lo que
 *    falte o esté mal aborta el arranque con un mensaje que nombra la
 *    variable: firmar subidas a medias (sin clave de firma de reproducción, o
 *    sin poder verificar el webhook) dejaría vídeos que nadie puede ver o
 *    estados que nunca cambian.
 *
 * La copia a Google Drive (antes de borrar los vídeos de un aula inactiva) es
 * opcional: sin `GOOGLE_DRIVE_BACKUP_SA_JSON` la política de inactividad corre
 * EN SECO — avisa, calcula y audita, pero no borra ni archiva nada, porque
 * sin copia confirmada no se borra ningún vídeo.
 *
 * Los valores de las claves no aparecen NUNCA en un mensaje de error.
 */

export const VIDEO_CLOUD_ENV = {
  apiKey: 'BUNNY_STREAM_API_KEY',
  libraryId: 'BUNNY_STREAM_LIBRARY_ID',
  cdnHostname: 'BUNNY_STREAM_CDN_HOSTNAME',
  tokenKey: 'BUNNY_STREAM_TOKEN_KEY',
  webhookSecret: 'BUNNY_STREAM_WEBHOOK_SECRET',
  /** Solo para pruebas locales contra un doble de Bunny. */
  apiBaseUrl: 'BUNNY_STREAM_API_BASE_URL',
  tusEndpoint: 'BUNNY_STREAM_TUS_ENDPOINT',
  driveServiceAccount: 'GOOGLE_DRIVE_BACKUP_SA_JSON',
  driveFolderId: 'GOOGLE_DRIVE_BACKUP_FOLDER_ID',
  /** Correo del operador para el aviso de coste (opcional; si no, solo al log). */
  operatorAlertEmail: 'VIDEO_CLOUD_OPERATOR_ALERT_EMAIL',
} as const;

export const BUNNY_STREAM_DEFAULT_API = 'https://video.bunnycdn.com';
export const BUNNY_STREAM_DEFAULT_TUS = 'https://video.bunnycdn.com/tusupload';

export interface GoogleServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
}

export interface DriveBackupConfig {
  readonly serviceAccount: GoogleServiceAccount;
  /** Carpeta (dentro de una unidad compartida) donde van las copias. */
  readonly folderId: string;
}

export interface VideoCloudDisabled {
  readonly enabled: false;
}

export interface VideoCloudEnabled {
  readonly enabled: true;
  /** Clave de la API de la biblioteca (escritura). */
  readonly apiKey: string;
  readonly libraryId: string;
  /** Host de la CDN de la biblioteca (`vz-….b-cdn.net`), sin esquema. */
  readonly cdnHostname: string;
  /**
   * Clave de firma de la biblioteca («Token authentication key» en
   * Security): firma el embed (`token` + `expires`) y las URL de la CDN
   * (miniaturas, copia de seguridad).
   */
  readonly tokenKey: string;
  /** Clave de solo lectura de la biblioteca: Bunny firma con ella el webhook. */
  readonly webhookSecret: string;
  readonly apiBaseUrl: string;
  readonly tusEndpoint: string;
  /** null: copia a Drive sin configurar → la inactividad corre en seco. */
  readonly drive: DriveBackupConfig | null;
  readonly operatorAlertEmail: string | null;
}

export type VideoCloudConfig = VideoCloudDisabled | VideoCloudEnabled;

export class VideoCloudConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      'Configuración de subida de vídeo (Bunny Stream) no válida:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nPara apagar la subida de vídeo, deja ${VIDEO_CLOUD_ENV.apiKey} sin definir.`,
    );
    this.name = 'VideoCloudConfigError';
  }
}

function read(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? '').trim();
}

function httpsUrl(raw: string, name: string, problems: string[]): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      problems.push(`${name} tiene que ser https.`);
    }
    return raw.replace(/\/+$/, '');
  } catch {
    problems.push(`${name} no es una URL válida.`);
    return raw;
  }
}

/**
 * La credencial de la cuenta de servicio de Google: el JSON que descarga la
 * consola, tal cual o en base64 (más cómodo en un `.env` de una línea).
 */
export function parseServiceAccount(raw: string): GoogleServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('no es un JSON (ni un JSON en base64)');
  }
  const clientEmail = json['client_email'];
  const privateKey = json['private_key'];
  const tokenUri = json['token_uri'] ?? 'https://oauth2.googleapis.com/token';
  if (json['type'] !== 'service_account') throw new Error('no es de tipo service_account');
  if (typeof clientEmail !== 'string' || !clientEmail.includes('@')) {
    throw new Error('le falta client_email');
  }
  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) {
    throw new Error('le falta private_key');
  }
  if (typeof tokenUri !== 'string' || !tokenUri.startsWith('https://')) {
    throw new Error('token_uri no es https');
  }
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error('private_key no se puede leer');
  }
  return { clientEmail, privateKey, tokenUri };
}

export function loadVideoCloudConfig(env: NodeJS.ProcessEnv = process.env): VideoCloudConfig {
  const apiKey = read(env, VIDEO_CLOUD_ENV.apiKey);
  if (!apiKey) return { enabled: false };

  const problems: string[] = [];
  const libraryId = read(env, VIDEO_CLOUD_ENV.libraryId);
  if (!BUNNY_LIBRARY_ID_RE.test(libraryId)) {
    problems.push(`${VIDEO_CLOUD_ENV.libraryId} tiene que ser el número de la biblioteca.`);
  }
  const cdnRaw = read(env, VIDEO_CLOUD_ENV.cdnHostname)
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cdnRaw)) {
    problems.push(
      `${VIDEO_CLOUD_ENV.cdnHostname} tiene que ser el host de la CDN (p. ej. vz-1234abcd-567.b-cdn.net).`,
    );
  }
  const tokenKey = read(env, VIDEO_CLOUD_ENV.tokenKey);
  if (tokenKey.length < 8) {
    problems.push(
      `${VIDEO_CLOUD_ENV.tokenKey} es obligatoria: sin ella los vídeos se servirían sin firmar.`,
    );
  } else if (tokenKey === apiKey) {
    problems.push(
      `${VIDEO_CLOUD_ENV.tokenKey} no puede ser la API key: es la «Token authentication key» de Security.`,
    );
  }
  const webhookSecret = read(env, VIDEO_CLOUD_ENV.webhookSecret);
  if (webhookSecret.length < 8) {
    problems.push(
      `${VIDEO_CLOUD_ENV.webhookSecret} es obligatoria (la «Read-only API key» de la biblioteca): sin ella no se puede verificar el webhook.`,
    );
  } else if (webhookSecret === apiKey) {
    problems.push(
      `${VIDEO_CLOUD_ENV.webhookSecret} es la clave de SOLO LECTURA de la biblioteca, no la de escritura.`,
    );
  }
  const apiBaseUrl = httpsUrl(
    read(env, VIDEO_CLOUD_ENV.apiBaseUrl) || BUNNY_STREAM_DEFAULT_API,
    VIDEO_CLOUD_ENV.apiBaseUrl,
    problems,
  );
  const tusEndpoint = httpsUrl(
    read(env, VIDEO_CLOUD_ENV.tusEndpoint) || BUNNY_STREAM_DEFAULT_TUS,
    VIDEO_CLOUD_ENV.tusEndpoint,
    problems,
  );

  let drive: DriveBackupConfig | null = null;
  const saRaw = read(env, VIDEO_CLOUD_ENV.driveServiceAccount);
  const folderId = read(env, VIDEO_CLOUD_ENV.driveFolderId);
  if (saRaw || folderId) {
    if (!saRaw)
      problems.push(`${VIDEO_CLOUD_ENV.driveServiceAccount} falta (hay carpeta sin credencial).`);
    if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId)) {
      problems.push(`${VIDEO_CLOUD_ENV.driveFolderId} tiene que ser el id de la carpeta de Drive.`);
    }
    if (saRaw) {
      try {
        const serviceAccount = parseServiceAccount(saRaw);
        if (problems.length === 0) drive = { serviceAccount, folderId };
      } catch (err) {
        problems.push(
          `${VIDEO_CLOUD_ENV.driveServiceAccount} no es válida: ${(err as Error).message}.`,
        );
      }
    }
  }

  const alert = read(env, VIDEO_CLOUD_ENV.operatorAlertEmail);
  if (alert && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alert)) {
    problems.push(`${VIDEO_CLOUD_ENV.operatorAlertEmail} no es un correo.`);
  }

  if (problems.length > 0) throw new VideoCloudConfigError(problems);
  return {
    enabled: true,
    apiKey,
    libraryId,
    cdnHostname: cdnRaw.toLowerCase(),
    tokenKey,
    webhookSecret,
    apiBaseUrl,
    tusEndpoint,
    drive,
    operatorAlertEmail: alert || null,
  };
}

let cached: VideoCloudConfig | undefined;

/** La del proceso, leída una vez. */
export function getVideoCloudConfig(): VideoCloudConfig {
  cached ??= loadVideoCloudConfig();
  return cached;
}
