/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createSign } from 'node:crypto';
import type { GoogleServiceAccount } from './video-cloud.config';

/**
 * Copias de vídeo en Google Drive con una CUENTA DE SERVICIO, sin librerías de
 * Google: JWT RS256 firmado con `node:crypto` → token OAuth → API de Drive v3.
 *
 *  - Las copias van a una carpeta dentro de una UNIDAD COMPARTIDA. Una cuenta
 *    de servicio no tiene cuota propia en Drive, así que no puede guardar nada
 *    en «Mi unidad»: la unidad compartida pone el espacio (el de Workspace).
 *    Por eso todas las llamadas llevan `supportsAllDrives=true`.
 *  - La subida es reanudable y por trozos de 16 MiB (múltiplos de 256 KiB,
 *    como pide Drive), sin saber el tamaño total hasta el último trozo: el
 *    vídeo pasa de la CDN de Bunny a Drive sin tocar el disco ni cargarse
 *    entero en memoria.
 *  - Borrar es definitivo (`DELETE /files/{id}`, no a la papelera): a los 90
 *    días o al pedir la supresión (RGPD) la copia tiene que desaparecer de
 *    verdad. En una unidad compartida eso exige rol «Administrador».
 *
 * https://developers.google.com/identity/protocols/oauth2/service-account
 * https://developers.google.com/drive/api/guides/manage-uploads#resumable
 */

export interface DriveUploadResult {
  fileId: string;
  bytes: number;
}

export interface GoogleDriveClient {
  upload(input: {
    name: string;
    mimeType: string;
    folderId: string;
    appProperties: Record<string, string>;
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<DriveUploadResult>;
  /** Idempotente: lo que ya no existe cuenta como borrado. */
  deleteFile(fileId: string): Promise<'deleted' | 'not_found'>;
}

export class GoogleDriveError extends Error {
  constructor(
    readonly status: number,
    operation: string,
    detail: string,
  ) {
    super(`Google Drive ${operation} falló (${status}): ${detail}`);
    this.name = 'GoogleDriveError';
  }
}

const SCOPE = 'https://www.googleapis.com/auth/drive';
const CHUNK = 16 * 1024 * 1024;

type FetchLike = typeof fetch;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** JWT de la cuenta de servicio para pedir el token (RFC 7523). */
export function serviceAccountAssertion(sa: GoogleServiceAccount, nowUnix: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.clientEmail,
      scope: SCOPE,
      aud: sa.tokenUri,
      iat: nowUnix,
      exp: nowUnix + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.privateKey))}`;
}

export class FetchGoogleDriveClient implements GoogleDriveClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly opts: {
      serviceAccount: GoogleServiceAccount;
      fetch?: FetchLike;
      now?: () => number;
      chunkBytes?: number;
    },
  ) {}

  private get f(): FetchLike {
    return this.opts.fetch ?? fetch;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const assertion = serviceAccountAssertion(
      this.opts.serviceAccount,
      Math.floor(this.now() / 1000),
    );
    const res = await this.f(this.opts.serviceAccount.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new GoogleDriveError(res.status, 'token', json.error ?? 'sin token');
    }
    this.token = {
      value: json.access_token,
      expiresAt: this.now() + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  }

  async upload(input: {
    name: string;
    mimeType: string;
    folderId: string;
    appProperties: Record<string, string>;
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<DriveUploadResult> {
    const token = await this.accessToken();
    const start = await this.f(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,size',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': input.mimeType,
        },
        body: JSON.stringify({
          name: input.name,
          parents: [input.folderId],
          mimeType: input.mimeType,
          appProperties: input.appProperties,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const session = start.headers.get('location');
    if (!start.ok || !session) {
      throw new GoogleDriveError(start.status, 'upload-start', await safeText(start));
    }

    const size = this.opts.chunkBytes ?? CHUNK;
    let buffer = Buffer.alloc(0);
    let offset = 0;
    const iterator = input.chunks[Symbol.asyncIterator]();
    let done = false;
    let fileId: string | null = null;

    while (!done || buffer.length > 0) {
      while (!done && buffer.length < size) {
        const next = await iterator.next();
        if (next.done) done = true;
        else buffer = Buffer.concat([buffer, Buffer.from(next.value)]);
      }
      const isLast = done;
      const take = isLast ? buffer.length : size;
      const piece = buffer.subarray(0, take);
      const end = offset + piece.length - 1;
      const total = isLast ? String(offset + piece.length) : '*';
      const range = piece.length === 0 ? `bytes */${total}` : `bytes ${offset}-${end}/${total}`;
      const res = await this.f(session, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          'content-range': range,
        },
        body: piece,
        signal: AbortSignal.timeout(300_000),
      });
      if (res.status === 308) {
        if (isLast) throw new GoogleDriveError(308, 'upload', 'Drive pide más bytes al final');
        offset += piece.length;
        buffer = Buffer.from(buffer.subarray(take));
        continue;
      }
      if (!res.ok) throw new GoogleDriveError(res.status, 'upload', await safeText(res));
      const json = (await res.json().catch(() => ({}))) as { id?: string; size?: string };
      if (!json.id) throw new GoogleDriveError(res.status, 'upload', 'respuesta sin id');
      offset += piece.length;
      // Copia CONFIRMADA: lo que Drive dice que guardó es lo que se mandó.
      if (json.size !== undefined && Number(json.size) !== offset) {
        throw new GoogleDriveError(
          res.status,
          'upload',
          `Drive guardó ${json.size} bytes de ${offset}`,
        );
      }
      fileId = json.id;
      break;
    }
    if (!fileId) throw new GoogleDriveError(0, 'upload', 'la subida no terminó');
    return { fileId, bytes: offset };
  }

  async deleteFile(fileId: string): Promise<'deleted' | 'not_found'> {
    const res = await this.f(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await this.accessToken()}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (res.status === 404) return 'not_found';
    if (!res.ok) throw new GoogleDriveError(res.status, 'delete', await safeText(res));
    return 'deleted';
  }
}

async function safeText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 200) || 'sin detalle';
}
