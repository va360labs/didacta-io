/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import {
  BUNNY_VIDEO_STATUS,
  type BunnyCollection,
  type BunnyStreamClient,
  type BunnyVideo,
} from '../../src/video/cloud/bunny-stream.client';

/**
 * Doble EN MEMORIA de una biblioteca de Bunny Stream: guarda colecciones y
 * vídeos y deja que el test los mueva de estado (subido, codificado, fallido,
 * visto…). Registra cada llamada para poder afirmar sobre ella.
 */
export class BunnyStreamDouble implements BunnyStreamClient {
  readonly collections = new Map<string, BunnyCollection>();
  readonly videos = new Map<string, BunnyVideo>();
  readonly calls: string[] = [];
  /** Si se pone, la próxima llamada con ese nombre lanza. */
  failNext: Partial<Record<'createVideo' | 'deleteVideo' | 'deleteResolutions', Error>> = {};

  constructor(readonly libraryId = '700900') {}

  async listCollections(search: string): Promise<BunnyCollection[]> {
    this.calls.push(`listCollections:${search}`);
    return [...this.collections.values()].filter((c) =>
      c.name.toLowerCase().includes(search.toLowerCase()),
    );
  }

  async createCollection(name: string): Promise<BunnyCollection> {
    this.calls.push(`createCollection:${name}`);
    const c = { guid: randomUUID(), name };
    this.collections.set(c.guid, c);
    return c;
  }

  async createVideo(input: { title: string; collectionId: string | null }): Promise<BunnyVideo> {
    this.calls.push(`createVideo:${input.title}`);
    const err = this.failNext.createVideo;
    if (err) {
      delete this.failNext.createVideo;
      throw err;
    }
    const v: BunnyVideo = {
      guid: randomUUID(),
      title: input.title,
      status: BUNNY_VIDEO_STATUS.CREATED,
      length: 0,
      storageSize: 0,
      totalWatchTime: 0,
      availableResolutions: null,
      collectionId: input.collectionId,
      thumbnailFileName: null,
      encodeProgress: 0,
      width: 0,
      height: 0,
      dateUploadedMs: Date.now(),
    };
    this.videos.set(v.guid, v);
    return { ...v };
  }

  async getVideo(guid: string): Promise<BunnyVideo | null> {
    this.calls.push(`getVideo:${guid}`);
    const v = this.videos.get(guid);
    return v ? { ...v } : null;
  }

  async listVideos(input: {
    collectionId: string;
    page: number;
    itemsPerPage: number;
  }): Promise<{ items: BunnyVideo[]; totalItems: number }> {
    this.calls.push(`listVideos:${input.collectionId}:${input.page}`);
    const all = [...this.videos.values()].filter((v) => v.collectionId === input.collectionId);
    const start = (input.page - 1) * input.itemsPerPage;
    return {
      items: all.slice(start, start + input.itemsPerPage).map((v) => ({ ...v })),
      totalItems: all.length,
    };
  }

  async deleteVideo(guid: string): Promise<'deleted' | 'not_found'> {
    this.calls.push(`deleteVideo:${guid}`);
    const err = this.failNext.deleteVideo;
    if (err) {
      delete this.failNext.deleteVideo;
      throw err;
    }
    return this.videos.delete(guid) ? 'deleted' : 'not_found';
  }

  async deleteResolutions(guid: string, resolutions: readonly string[]): Promise<void> {
    this.calls.push(`deleteResolutions:${guid}:${resolutions.join(',')}`);
    const err = this.failNext.deleteResolutions;
    if (err) {
      delete this.failNext.deleteResolutions;
      throw err;
    }
    const v = this.videos.get(guid);
    if (!v) return;
    v.availableResolutions =
      (v.availableResolutions ?? '')
        .split(',')
        .filter((r) => r && !resolutions.includes(r))
        .join(',') || null;
  }

  // ─── lo que en la realidad hace Bunny por su cuenta ───

  /** El navegador terminó de subir y Bunny codificó. */
  finish(
    guid: string,
    opts: { lengthSeconds: number; storageBytes?: number; resolutions?: string },
  ): void {
    const v = this.videos.get(guid)!;
    v.status = BUNNY_VIDEO_STATUS.FINISHED;
    v.length = opts.lengthSeconds;
    v.storageSize = opts.storageBytes ?? opts.lengthSeconds * 500_000;
    v.availableResolutions = opts.resolutions ?? '240p,360p,480p,720p,1080p';
    v.encodeProgress = 100;
  }

  processing(guid: string): void {
    this.videos.get(guid)!.status = BUNNY_VIDEO_STATUS.TRANSCODING;
  }

  fail(guid: string): void {
    this.videos.get(guid)!.status = BUNNY_VIDEO_STATUS.ERROR;
  }

  watched(guid: string, totalSeconds: number): void {
    this.videos.get(guid)!.totalWatchTime = totalSeconds;
  }

  /** Un vídeo en la colección que nadie registró, subido en `uploadedAtMs`. */
  orphan(collectionId: string, uploadedAtMs: number): string {
    const guid = randomUUID();
    this.videos.set(guid, {
      guid,
      title: 'huérfano',
      status: BUNNY_VIDEO_STATUS.FINISHED,
      length: 60,
      storageSize: 1,
      totalWatchTime: 0,
      availableResolutions: '720p',
      collectionId,
      thumbnailFileName: null,
      encodeProgress: 100,
      width: 0,
      height: 0,
      dateUploadedMs: uploadedAtMs,
    });
    return guid;
  }
}
