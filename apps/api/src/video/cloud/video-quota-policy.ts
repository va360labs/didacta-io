/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Límites del vídeo subido a Didacta Cloud (decididos por el dueño):
 *
 *  - Antes de la primera venta: 5 h almacenadas, 720p como máximo y 100 h
 *    vistas al mes.
 *  - Después: 50 h almacenadas y más según lo vendido, 1080p, sin tope de
 *    horas vistas.
 *  - Por fichero: 4 GB y 2 h.
 *  - Aviso (al operador) si lo que cuesta el vídeo de un aula supera el 30 %
 *    de la comisión que deja.
 *
 * Todo puro: sin red ni base de datos. Los tests fijan cada umbral.
 */

const HOUR = 3600;

export const VIDEO_LIMITS = {
  /** 4 GB, en la unidad que enseña el explorador de archivos (GiB). */
  maxFileBytes: 4 * 1024 ** 3,
  maxFileSeconds: 2 * HOUR,
  preSale: {
    storedSeconds: 5 * HOUR,
    watchedSecondsPerMonth: 100 * HOUR,
    maxResolution: '720p',
  },
  postSale: {
    storedSeconds: 50 * HOUR,
    maxResolution: '1080p',
  },
  /**
   * «Más según lo vendido»: 10 h más por cada 30 € de comisión del operador
   * en los últimos 12 meses. Con los precios de Bunny de abajo, una hora a
   * 1080p (~4 GB entre todas sus resoluciones) cuesta ~1 € al año: 10 h por
   * 30 € deja el vídeo en torno al 30 % de lo que esas ventas dejan.
   */
  bonusSecondsPerStep: 10 * HOUR,
  bonusStepMinorEur: 3000,
  /** Margen sobre el tope antes de rechazar un vídeo ya codificado. */
  storedToleranceRatio: 0.05,
} as const;

/** Resoluciones que se le quitan a un vídeo cuyo máximo es 720p. */
export const RESOLUTIONS_ABOVE_720P = ['1080p', '1440p', '2160p'] as const;

/**
 * Precios para estimar el coste del vídeo de un aula (EUR, aproximados a
 * noviembre de 2026; solo sirven para el aviso del 30 %).
 *  - Almacenamiento de Stream: ~0,01 €/GB·mes por región, dos regiones.
 *  - Entrega por la red «volumen»: ~0,005 €/GB.
 *  - Lo que se descarga por hora vista: ~1,5 GB (mezcla de 720p y 1080p).
 */
export const VIDEO_COST_MODEL = {
  storageEurPerGbMonth: 0.02,
  deliveryEurPerGb: 0.005,
  deliveredGbPerWatchedHour: 1.5,
  alertRatio: 0.3,
} as const;

export type VideoTier = 'pre_sale' | 'post_sale';

export interface VideoQuota {
  tier: VideoTier;
  maxResolution: '720p' | '1080p';
  storedLimitSeconds: number;
  /** Horas extra por ventas ya incluidas en `storedLimitSeconds`. */
  bonusSeconds: number;
  /** null = sin tope mensual. */
  watchedLimitSecondsPerMonth: number | null;
  maxFileBytes: number;
  maxFileSeconds: number;
  /** Lo que tendría tras la primera venta (para el mensaje al creador). */
  postSaleStoredSeconds: number;
}

/**
 * @param hasSale         ¿El aula ha vendido algo (y no lo ha devuelto entero)?
 * @param commission12mEur Comisión del operador en los últimos 12 meses, en
 *                         céntimos de euro.
 */
export function quotaFor(input: { hasSale: boolean; commission12mEur: number }): VideoQuota {
  if (!input.hasSale) {
    return {
      tier: 'pre_sale',
      maxResolution: '720p',
      storedLimitSeconds: VIDEO_LIMITS.preSale.storedSeconds,
      bonusSeconds: 0,
      watchedLimitSecondsPerMonth: VIDEO_LIMITS.preSale.watchedSecondsPerMonth,
      maxFileBytes: VIDEO_LIMITS.maxFileBytes,
      maxFileSeconds: VIDEO_LIMITS.maxFileSeconds,
      postSaleStoredSeconds: VIDEO_LIMITS.postSale.storedSeconds,
    };
  }
  const steps = Math.max(
    0,
    Math.floor(Math.max(0, input.commission12mEur) / VIDEO_LIMITS.bonusStepMinorEur),
  );
  const bonusSeconds = steps * VIDEO_LIMITS.bonusSecondsPerStep;
  return {
    tier: 'post_sale',
    maxResolution: '1080p',
    storedLimitSeconds: VIDEO_LIMITS.postSale.storedSeconds + bonusSeconds,
    bonusSeconds,
    watchedLimitSecondsPerMonth: null,
    maxFileBytes: VIDEO_LIMITS.maxFileBytes,
    maxFileSeconds: VIDEO_LIMITS.maxFileSeconds,
    postSaleStoredSeconds: VIDEO_LIMITS.postSale.storedSeconds,
  };
}

export type UploadRejection =
  | { code: 'VIDEO_FILE_TOO_BIG'; limitBytes: number }
  | { code: 'VIDEO_FILE_TOO_LONG'; limitSeconds: number }
  | {
      code: 'VIDEO_STORAGE_QUOTA';
      usedSeconds: number;
      limitSeconds: number;
      tier: VideoTier;
      postSaleStoredSeconds: number;
    }
  | { code: 'VIDEO_NOT_A_VIDEO' };

/** Extensiones de vídeo que Bunny codifica aunque el navegador no sepa su tipo. */
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|flv|3gp|ts|mts)$/i;

/**
 * Algunos navegadores no ponen tipo a un `.mkv` o un `.mts` (llega vacío o
 * `application/octet-stream`): ahí manda la extensión.
 */
export function looksLikeVideo(mimeType: string, fileName: string): boolean {
  if (/^video\//i.test(mimeType)) return true;
  if (mimeType && mimeType !== 'application/octet-stream') return false;
  return VIDEO_EXTENSIONS.test(fileName);
}

/**
 * ¿Se puede firmar esta subida? Se decide ANTES de que el navegador mande un
 * solo byte, con lo que dice de su fichero. Cuando Bunny termina de codificar
 * se vuelve a mirar con lo que midió él (`checkEncoded`).
 */
export function checkUpload(input: {
  quota: VideoQuota;
  usedSeconds: number;
  sizeBytes: number;
  durationSeconds: number;
  mimeType: string;
  fileName: string;
}): UploadRejection | null {
  if (!looksLikeVideo(input.mimeType, input.fileName)) return { code: 'VIDEO_NOT_A_VIDEO' };
  if (input.sizeBytes > input.quota.maxFileBytes) {
    return { code: 'VIDEO_FILE_TOO_BIG', limitBytes: input.quota.maxFileBytes };
  }
  if (input.durationSeconds > input.quota.maxFileSeconds) {
    return { code: 'VIDEO_FILE_TOO_LONG', limitSeconds: input.quota.maxFileSeconds };
  }
  if (input.usedSeconds + input.durationSeconds > input.quota.storedLimitSeconds) {
    return {
      code: 'VIDEO_STORAGE_QUOTA',
      usedSeconds: input.usedSeconds,
      limitSeconds: input.quota.storedLimitSeconds,
      tier: input.quota.tier,
      postSaleStoredSeconds: input.quota.postSaleStoredSeconds,
    };
  }
  return null;
}

/**
 * Ya codificado: ¿se queda? `usedOthersSeconds` es lo que ocupan los DEMÁS
 * vídeos del aula. Se deja un 5 % de margen: la duración que mide el navegador
 * y la de Bunny difieren en algún segundo.
 */
export function checkEncoded(input: {
  quota: VideoQuota;
  usedOthersSeconds: number;
  lengthSeconds: number;
}): 'ok' | 'too_long' | 'quota' {
  const slack = Math.ceil(input.quota.maxFileSeconds * VIDEO_LIMITS.storedToleranceRatio);
  if (input.lengthSeconds > input.quota.maxFileSeconds + slack) return 'too_long';
  const limit = input.quota.storedLimitSeconds * (1 + VIDEO_LIMITS.storedToleranceRatio);
  if (input.usedOthersSeconds + input.lengthSeconds > limit) return 'quota';
  return 'ok';
}

/** ¿Ha llegado el aula al tope de horas vistas de este mes? */
export function watchQuotaExceeded(quota: VideoQuota, watchedSecondsThisMonth: number): boolean {
  return (
    quota.watchedLimitSecondsPerMonth !== null &&
    watchedSecondsThisMonth >= quota.watchedLimitSecondsPerMonth
  );
}

/**
 * Coste estimado del vídeo de un aula en un mes y si supera el 30 % de la
 * comisión media mensual del último año. Sin comisión no hay aviso: el aula
 * está en el tramo de antes de vender, que ya tiene sus topes.
 */
export function costAlert(input: {
  storageBytes: number;
  watchedSecondsMonth: number;
  commission12mEur: number;
}): { costEur: number; commissionMonthEur: number; ratio: number; alert: boolean } {
  const gb = input.storageBytes / 1e9;
  const watchedHours = input.watchedSecondsMonth / HOUR;
  const costEur =
    gb * VIDEO_COST_MODEL.storageEurPerGbMonth +
    watchedHours * VIDEO_COST_MODEL.deliveredGbPerWatchedHour * VIDEO_COST_MODEL.deliveryEurPerGb;
  const commissionMonthEur = Math.max(0, input.commission12mEur) / 100 / 12;
  if (commissionMonthEur <= 0) return { costEur, commissionMonthEur, ratio: 0, alert: false };
  const ratio = costEur / commissionMonthEur;
  return { costEur, commissionMonthEur, ratio, alert: ratio > VIDEO_COST_MODEL.alertRatio };
}

/** `YYYY-MM` (UTC). */
export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}
