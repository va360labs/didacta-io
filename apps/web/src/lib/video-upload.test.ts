/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from './api-client';
import {
  formatBytes,
  formatDuration,
  looksLikeVideo,
  preflight,
  usedPercent,
  videoUploadApi,
  type VideoQuota,
} from './video-upload';

vi.mock('./auth-storage', () => ({ authStorage: { getAccessToken: () => 'tok' } }));
vi.mock('./api-client', async (orig) => {
  const real = await orig<typeof import('./api-client')>();
  return { ...real, apiFetch: vi.fn() };
});

const H = 3600;
const quota: VideoQuota = {
  tier: 'pre_sale',
  maxResolution: '720p',
  stored: { usedSeconds: 4 * H + 20 * 60, limitSeconds: 5 * H, bonusSeconds: 0 },
  watched: { month: '2026-11', usedSeconds: 0, limitSeconds: 100 * H },
  maxFileBytes: 4 * 1024 ** 3,
  maxFileSeconds: 2 * H,
  postSaleStoredSeconds: 50 * H,
};

describe('formato en llano', () => {
  it('duraciones', () => {
    expect(formatDuration(4 * H + 20 * 60)).toBe('4 h 20 min');
    expect(formatDuration(5 * H)).toBe('5 h');
    expect(formatDuration(45 * 60 + 59)).toBe('45 min');
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(-5)).toBe('0 min');
  });

  it('tamaños', () => {
    expect(formatBytes(4 * 1024 ** 3)).toBe('4 GB');
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1,3 GB');
    expect(formatBytes(850 * 1024 ** 2)).toBe('850 MB');
    expect(formatBytes(10)).toBe('1 MB');
  });

  it('porcentaje de la barra', () => {
    expect(usedPercent(4 * H + 20 * 60, 5 * H)).toBe(87);
    expect(usedPercent(6 * H, 5 * H)).toBe(100);
    expect(usedPercent(10, null)).toBe(0);
  });
});

describe('comprobación antes de subir (la misma que hará el servidor)', () => {
  const file = (over: Partial<{ type: string; name: string; size: number }> = {}) => ({
    type: 'video/mp4',
    name: 'clase.mp4',
    size: 300 * 1024 ** 2,
    ...over,
  });

  it('cabe: nada que decir', () => {
    expect(preflight(file(), 40 * 60, quota)).toBeNull();
  });

  it('no cabe en el espacio que queda', () => {
    expect(preflight(file(), 41 * 60, quota)).toEqual({ kind: 'no_room', quota });
  });

  it('demasiado grande o largo, o no es vídeo', () => {
    expect(preflight(file({ size: 4 * 1024 ** 3 + 1 }), 60, quota)).toMatchObject({
      kind: 'too_big',
    });
    const roomy = { ...quota, stored: { ...quota.stored, usedSeconds: 0, limitSeconds: 50 * H } };
    expect(preflight(file(), 2 * H + 1, roomy)).toMatchObject({ kind: 'too_long' });
    expect(preflight(file({ type: 'application/pdf', name: 'a.pdf' }), 60, quota)).toEqual({
      kind: 'not_video',
    });
  });

  it('un .mkv sin tipo cuenta como vídeo; una imagen con nombre .mp4, no', () => {
    expect(looksLikeVideo({ type: '', name: 'grabacion.MKV' })).toBe(true);
    expect(looksLikeVideo({ type: 'image/png', name: 'x.mp4' })).toBe(false);
  });
});

describe('API', () => {
  afterEach(async () => {
    const { apiFetch } = await import('./api-client');
    vi.mocked(apiFetch).mockReset();
  });

  it('sin subida de vídeo en la instalación (404) o sin permiso (403): null, sin error', async () => {
    const { apiFetch } = await import('./api-client');
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiHttpError({ message: 'x', status: 404 }));
    expect(await videoUploadApi.quota()).toBeNull();
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiHttpError({ message: 'x', status: 403 }));
    expect(await videoUploadApi.quota()).toBeNull();
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiHttpError({ message: 'x', status: 500 }));
    await expect(videoUploadApi.quota()).rejects.toBeInstanceOf(ApiHttpError);
  });

  it('crear la subida manda los datos del fichero', async () => {
    const { apiFetch } = await import('./api-client');
    vi.mocked(apiFetch).mockResolvedValueOnce({ asset: {}, upload: {} });
    await videoUploadApi.create({
      lessonId: 'l1',
      fileName: 'a.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      durationSeconds: 5,
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/video/uploads',
      expect.objectContaining({ method: 'POST' }),
      'tok',
    );
    const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls.at(-1)![1]!.body));
    expect(body).toEqual({
      lessonId: 'l1',
      fileName: 'a.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      durationSeconds: 5,
    });
  });
});
