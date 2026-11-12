/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  VIDEO_LIMITS,
  checkEncoded,
  checkUpload,
  costAlert,
  looksLikeVideo,
  monthKey,
  quotaFor,
  watchQuotaExceeded,
} from '../src/video/cloud/video-quota-policy';

const H = 3600;
const GiB = 1024 ** 3;

describe('límites del vídeo subido', () => {
  it('antes de vender: 5 h, 720p y 100 h vistas al mes', () => {
    const q = quotaFor({ hasSale: false, commission12mEur: 0 });
    expect(q).toMatchObject({
      tier: 'pre_sale',
      maxResolution: '720p',
      storedLimitSeconds: 5 * H,
      watchedLimitSecondsPerMonth: 100 * H,
      maxFileBytes: 4 * GiB,
      maxFileSeconds: 2 * H,
      postSaleStoredSeconds: 50 * H,
    });
  });

  it('después de vender: 50 h, 1080p y sin tope de horas vistas', () => {
    const q = quotaFor({ hasSale: true, commission12mEur: 0 });
    expect(q).toMatchObject({
      tier: 'post_sale',
      maxResolution: '1080p',
      storedLimitSeconds: 50 * H,
      bonusSeconds: 0,
      watchedLimitSecondsPerMonth: null,
    });
  });

  it('«más según lo vendido»: 10 h por cada 30 € de comisión de los últimos 12 meses', () => {
    expect(quotaFor({ hasSale: true, commission12mEur: 2999 }).storedLimitSeconds).toBe(50 * H);
    expect(quotaFor({ hasSale: true, commission12mEur: 3000 }).storedLimitSeconds).toBe(60 * H);
    const q = quotaFor({ hasSale: true, commission12mEur: 9500 });
    expect(q.bonusSeconds).toBe(30 * H);
    expect(q.storedLimitSeconds).toBe(80 * H);
    // Sin venta, la comisión no suma (no la hay).
    expect(quotaFor({ hasSale: false, commission12mEur: 9500 }).storedLimitSeconds).toBe(5 * H);
  });
});

describe('¿se firma la subida?', () => {
  const pre = quotaFor({ hasSale: false, commission12mEur: 0 });
  const ok = {
    quota: pre,
    usedSeconds: 0,
    sizeBytes: 500 * 1024 ** 2,
    durationSeconds: 20 * 60,
    mimeType: 'video/mp4',
    fileName: 'clase-1.mp4',
  };

  it('un vídeo normal, sí', () => {
    expect(checkUpload(ok)).toBeNull();
  });

  it('4 GB justos pasan; un byte más, no', () => {
    expect(checkUpload({ ...ok, sizeBytes: 4 * GiB })).toBeNull();
    expect(checkUpload({ ...ok, sizeBytes: 4 * GiB + 1 })).toEqual({
      code: 'VIDEO_FILE_TOO_BIG',
      limitBytes: 4 * GiB,
    });
  });

  it('2 h justas pasan; más, no', () => {
    const post = quotaFor({ hasSale: true, commission12mEur: 0 });
    expect(checkUpload({ ...ok, quota: post, durationSeconds: 2 * H })).toBeNull();
    expect(checkUpload({ ...ok, quota: post, durationSeconds: 2 * H + 1 })).toMatchObject({
      code: 'VIDEO_FILE_TOO_LONG',
    });
  });

  it('cuota: 4 h 20 min usadas + 41 min no caben en 5 h; 40 min sí', () => {
    const used = 4 * H + 20 * 60;
    expect(checkUpload({ ...ok, usedSeconds: used, durationSeconds: 40 * 60 })).toBeNull();
    expect(checkUpload({ ...ok, usedSeconds: used, durationSeconds: 41 * 60 })).toEqual({
      code: 'VIDEO_STORAGE_QUOTA',
      usedSeconds: used,
      limitSeconds: 5 * H,
      tier: 'pre_sale',
      postSaleStoredSeconds: 50 * H,
    });
  });

  it('lo que no es vídeo no se firma; un .mkv sin tipo, sí', () => {
    expect(checkUpload({ ...ok, mimeType: 'application/pdf', fileName: 'a.pdf' })).toEqual({
      code: 'VIDEO_NOT_A_VIDEO',
    });
    expect(checkUpload({ ...ok, mimeType: '', fileName: 'grabacion.mkv' })).toBeNull();
    expect(looksLikeVideo('application/octet-stream', 'clase.MTS')).toBe(true);
    expect(looksLikeVideo('', 'notas.txt')).toBe(false);
    expect(looksLikeVideo('image/png', 'truco.mp4')).toBe(false);
  });
});

describe('ya codificado: ¿se queda?', () => {
  const pre = quotaFor({ hasSale: false, commission12mEur: 0 });

  it('con la duración real dentro de la cuota (con 5 % de margen)', () => {
    expect(checkEncoded({ quota: pre, usedOthersSeconds: 4 * H, lengthSeconds: H })).toBe('ok');
    expect(checkEncoded({ quota: pre, usedOthersSeconds: 4 * H, lengthSeconds: H + 15 * 60 })).toBe(
      'ok',
    );
    expect(checkEncoded({ quota: pre, usedOthersSeconds: 4 * H, lengthSeconds: H + 16 * 60 })).toBe(
      'quota',
    );
  });

  it('un vídeo que dijo durar 10 min y dura 3 h se rechaza', () => {
    const post = quotaFor({ hasSale: true, commission12mEur: 0 });
    expect(checkEncoded({ quota: post, usedOthersSeconds: 0, lengthSeconds: 3 * H })).toBe(
      'too_long',
    );
  });
});

describe('horas vistas y coste', () => {
  it('el tope de horas vistas solo existe antes de vender', () => {
    const pre = quotaFor({ hasSale: false, commission12mEur: 0 });
    const post = quotaFor({ hasSale: true, commission12mEur: 0 });
    expect(watchQuotaExceeded(pre, 100 * H - 1)).toBe(false);
    expect(watchQuotaExceeded(pre, 100 * H)).toBe(true);
    expect(watchQuotaExceeded(post, 10_000 * H)).toBe(false);
  });

  it('aviso cuando el vídeo cuesta más del 30 % de la comisión media mensual', () => {
    // 120 € de comisión al año = 10 €/mes → aviso por encima de 3 €.
    const cheap = costAlert({
      storageBytes: 50e9,
      watchedSecondsMonth: 50 * H,
      commission12mEur: 12000,
    });
    expect(cheap.alert).toBe(false);
    const pricey = costAlert({
      storageBytes: 100e9,
      watchedSecondsMonth: 300 * H,
      commission12mEur: 12000,
    });
    // 100 GB × 0,02 + 300 h × 1,5 GB × 0,005 = 2 + 2,25 = 4,25 €
    expect(pricey.costEur).toBeCloseTo(4.25, 5);
    expect(pricey.alert).toBe(true);
    expect(
      costAlert({ storageBytes: 1e12, watchedSecondsMonth: 0, commission12mEur: 0 }).alert,
    ).toBe(false);
  });

  it('el mes va en UTC', () => {
    expect(monthKey(new Date('2026-11-30T23:30:00Z'))).toBe('2026-11');
    expect(monthKey(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
  });

  it('los números del enunciado', () => {
    expect(VIDEO_LIMITS.preSale.storedSeconds).toBe(5 * H);
    expect(VIDEO_LIMITS.postSale.storedSeconds).toBe(50 * H);
  });
});
