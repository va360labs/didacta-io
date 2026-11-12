/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Logger } from '@nestjs/common';
import type { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import { BUNNY_GUID_RE, bunnyEmbedBaseUrl } from '../bunny-embed';
import { bunnyTusSignature, signBunnyCdnUrl } from './bunny-signing';
import { BUNNY_VIDEO_STATUS, type BunnyStreamClient, type BunnyVideo } from './bunny-stream.client';
import type { VideoCloudEnabled } from './video-cloud.config';
import type { CloudPlayDecision, CloudVideoLibrary } from './video-cloud.tokens';
import {
  RESOLUTIONS_ABOVE_720P,
  checkEncoded,
  checkUpload,
  monthKey,
  quotaFor,
  watchQuotaExceeded,
  type UploadRejection,
  type VideoQuota,
} from './video-quota-policy';

/** Prefijo de la colección de cada aula en la biblioteca de Cloud. */
export const COLLECTION_PREFIX = 'DC_';
/** Validez de la firma TUS: da para subir 4 GB con una conexión lenta y reanudar. */
export const TUS_SIGNATURE_TTL_SECONDS = 24 * 3600;
/** Un vídeo que ninguna lección usa se borra pasado este margen… */
export const UNREFERENCED_GRACE_MS = 60 * 60_000;
/** …y nunca antes de esto desde que se subió (el creador puede no haber guardado aún). */
export const NEW_UPLOAD_GRACE_MS = 24 * 3600_000;
/** Una subida firmada que nunca mandó bytes se da por abandonada. */
export const ABANDONED_UPLOAD_MS = 48 * 3600_000;
/** Un vídeo en la colección que no está en la base de datos (alta a medias). */
export const ORPHAN_GRACE_MS = 24 * 3600_000;
/** `last_played_at` se escribe como mucho una vez por este intervalo. */
const PLAY_TOUCH_MS = 10 * 60_000;
const QUOTA_CACHE_MS = 60_000;
const DAY_MS = 24 * 3600_000;

const LIVE_STATUSES = ['UPLOADING', 'PROCESSING', 'READY'] as const;
type AssetStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'DELETED';

export type VideoCloudErrorCode =
  | 'VIDEO_UPLOAD_LESSON_NOT_FOUND'
  | 'VIDEO_UPLOAD_LESSON_NOT_VIDEO'
  | 'VIDEO_UPLOAD_NOT_FOUND'
  | 'VIDEO_UPLOAD_NOT_RESUMABLE'
  | 'VIDEO_UPLOAD_IN_USE'
  | 'VIDEO_UPLOAD_BUSY'
  | 'VIDEO_UPLOAD_PROVIDER_ERROR'
  | UploadRejection['code'];

export class VideoCloudError extends Error {
  constructor(
    readonly code: VideoCloudErrorCode,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'VideoCloudError';
  }
}

export interface VideoAssetView {
  id: string;
  lessonId: string | null;
  title: string;
  status: AssetStatus;
  failureReason: string | null;
  durationSeconds: number | null;
  maxResolution: string;
  /** URL de embed que se guarda en la lección (`videoUrl`). */
  embedUrl: string;
  /** Miniatura firmada (1 h), solo cuando está listo. */
  thumbnailUrl: string | null;
  createdAt: string;
}

export interface TusUploadTicket {
  endpoint: string;
  /** Cabeceras que el cliente TUS manda tal cual. */
  headers: {
    AuthorizationSignature: string;
    AuthorizationExpire: string;
    VideoId: string;
    LibraryId: string;
  };
  metadata: { filetype: string; title: string; collection: string };
  expiresAt: string;
}

export interface VideoQuotaView {
  tier: VideoQuota['tier'];
  maxResolution: VideoQuota['maxResolution'];
  stored: { usedSeconds: number; limitSeconds: number; bonusSeconds: number };
  watched: { month: string; usedSeconds: number; limitSeconds: number | null };
  maxFileBytes: number;
  maxFileSeconds: number;
  postSaleStoredSeconds: number;
}

export interface TenantQuotaState {
  quota: VideoQuota;
  usedSeconds: number;
  watchedThisMonth: number;
  commission12mEur: number;
  hasSale: boolean;
}

interface AssetRow {
  id: string;
  tenantId: string;
  lessonId: string | null;
  libraryId: string;
  bunnyGuid: string;
  collectionId: string | null;
  title: string;
  status: AssetStatus;
  failureReason: string | null;
  declaredSeconds: number;
  durationSeconds: number | null;
  storageBytes: bigint | null;
  maxResolution: string;
  availableResolutions: string | null;
  resolutionsCapped: boolean;
  watchSecondsTotal: bigint;
  lastPlayedAt: Date | null;
  unreferencedSince: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
}

/** Estado de Bunny → estado nuestro. */
export function statusFromBunny(status: number): AssetStatus {
  switch (status) {
    case BUNNY_VIDEO_STATUS.CREATED:
      return 'UPLOADING';
    case BUNNY_VIDEO_STATUS.FINISHED:
      return 'READY';
    case BUNNY_VIDEO_STATUS.ERROR:
    case BUNNY_VIDEO_STATUS.UPLOAD_FAILED:
      return 'FAILED';
    default:
      return 'PROCESSING';
  }
}

/** Título del vídeo en Bunny: el nombre del fichero sin extensión, limpio. */
export function cleanTitle(fileName: string): string {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const clean = [...base]
    // Fuera los caracteres de control (saltos de línea, tabuladores…).
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || 'Vídeo').slice(0, 200);
}

/** El slug como lo admite el nombre de una colección. */
export function collectionNameFor(slug: string): string {
  return `${COLLECTION_PREFIX}${slug.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100)}`;
}

/**
 * Subida de vídeo a la biblioteca de Bunny Stream de Didacta Cloud: la
 * colección `DC_<slug>` de cada aula, la firma TUS, las cuotas, el estado que
 * dice Bunny y la limpieza de lo que ninguna lección usa.
 *
 * Todo lo que es de un aula corre con `runAsTenant` (RLS). Solo dos lecturas
 * son globales y sancionadas: de qué aula es un GUID (webhook) y qué aulas
 * tienen vídeo (barridos).
 */
export class VideoCloudService implements CloudVideoLibrary {
  private readonly logger = new Logger(VideoCloudService.name);
  private readonly quotaCache = new Map<string, { value: TenantQuotaState; expiresAt: number }>();
  private readonly now: () => Date;

  constructor(
    private readonly config: VideoCloudEnabled,
    private readonly prisma: PrismaService,
    private readonly bunny: BunnyStreamClient,
    private readonly auditLog: PrismaAuditLogService,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  get libraryId(): string {
    return this.config.libraryId;
  }

  // ───────────────────────────── cuotas ─────────────────────────────

  async quotaState(tenantId: string, opts: { fresh?: boolean } = {}): Promise<TenantQuotaState> {
    const nowMs = this.now().getTime();
    const hit = this.quotaCache.get(tenantId);
    if (!opts.fresh && hit && hit.expiresAt > nowMs) return hit.value;

    const value = await runAsTenant(tenantId, async () => {
      const since = new Date(nowMs - 365 * DAY_MS);
      const [sales, live, month] = await Promise.all([
        this.prisma.modPayoutsSale.findMany({
          where: { tenantId, chargedAt: { not: null } },
          select: {
            chargedAt: true,
            gross: true,
            presentmentAmount: true,
            refundedAmount: true,
            platformFee: true,
            currency: true,
          },
          orderBy: { chargedAt: 'desc' },
          take: 5000,
        }),
        this.prisma.videoAsset.findMany({
          where: { tenantId, deletedAt: null, status: { in: [...LIVE_STATUSES] } },
          select: { durationSeconds: true, declaredSeconds: true },
        }),
        this.prisma.videoUsageMonth.findUnique({
          where: { tenantId_month: { tenantId, month: monthKey(this.now()) } },
          select: { watchedSeconds: true },
        }),
      ]);

      let hasSale = false;
      let commission12mEur = 0;
      for (const s of sales) {
        const base = s.gross ?? s.presentmentAmount;
        const kept = base > 0 ? Math.max(0, base - s.refundedAmount) / base : 0;
        // Una venta devuelta entera no cuenta como «primera venta».
        if (kept > 0) hasSale = true;
        if (s.chargedAt && s.chargedAt >= since && (s.currency ?? '').toLowerCase() === 'eur') {
          commission12mEur += Math.round((s.platformFee ?? 0) * kept);
        }
      }
      const usedSeconds = live.reduce(
        (acc, a) => acc + (a.durationSeconds ?? a.declaredSeconds),
        0,
      );
      return {
        quota: quotaFor({ hasSale, commission12mEur }),
        usedSeconds,
        watchedThisMonth: Number(month?.watchedSeconds ?? 0n),
        commission12mEur,
        hasSale,
      };
    });
    if (this.quotaCache.size > 5000) this.quotaCache.clear();
    this.quotaCache.set(tenantId, { value, expiresAt: nowMs + QUOTA_CACHE_MS });
    return value;
  }

  async quotaView(tenantId: string): Promise<VideoQuotaView> {
    const s = await this.quotaState(tenantId, { fresh: true });
    return {
      tier: s.quota.tier,
      maxResolution: s.quota.maxResolution,
      stored: {
        usedSeconds: s.usedSeconds,
        limitSeconds: s.quota.storedLimitSeconds,
        bonusSeconds: s.quota.bonusSeconds,
      },
      watched: {
        month: monthKey(this.now()),
        usedSeconds: s.watchedThisMonth,
        limitSeconds: s.quota.watchedLimitSecondsPerMonth,
      },
      maxFileBytes: s.quota.maxFileBytes,
      maxFileSeconds: s.quota.maxFileSeconds,
      postSaleStoredSeconds: s.quota.postSaleStoredSeconds,
    };
  }

  // ───────────────────────────── subida ─────────────────────────────

  async createUpload(input: {
    tenantId: string;
    userId: string;
    lessonId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number;
  }): Promise<{ asset: VideoAssetView; upload: TusUploadTicket }> {
    const { tenantId } = input;
    const lesson = await runAsTenant(tenantId, () =>
      this.prisma.modCoursesLesson.findFirst({
        where: { id: input.lessonId, tenantId, deletedAt: null },
        select: { id: true, type: true },
      }),
    );
    if (!lesson) {
      throw new VideoCloudError('VIDEO_UPLOAD_LESSON_NOT_FOUND', 404, 'Lección no encontrada.');
    }
    if (lesson.type !== 'VIDEO') {
      throw new VideoCloudError(
        'VIDEO_UPLOAD_LESSON_NOT_VIDEO',
        400,
        'Solo se puede subir un vídeo a una lección de tipo vídeo.',
      );
    }

    const state = await this.quotaState(tenantId, { fresh: true });
    const rejection = checkUpload({
      quota: state.quota,
      usedSeconds: state.usedSeconds,
      sizeBytes: input.sizeBytes,
      durationSeconds: input.durationSeconds,
      mimeType: input.mimeType,
      fileName: input.fileName,
    });
    if (rejection) {
      const { code, ...details } = rejection;
      throw new VideoCloudError(code, code === 'VIDEO_STORAGE_QUOTA' ? 409 : 400, code, details);
    }

    const collectionId = await this.ensureCollection(tenantId);
    const title = cleanTitle(input.fileName);
    let video: BunnyVideo;
    try {
      video = await this.bunny.createVideo({ title, collectionId });
    } catch (err) {
      this.logger.error(`Bunny no creó el vídeo (tenant ${tenantId}): ${(err as Error).message}`);
      throw new VideoCloudError(
        'VIDEO_UPLOAD_PROVIDER_ERROR',
        502,
        'No se pudo preparar la subida. Inténtalo de nuevo en un momento.',
      );
    }

    let row: AssetRow;
    try {
      row = (await runAsTenant(tenantId, () =>
        this.prisma.videoAsset.create({
          data: {
            tenantId,
            lessonId: input.lessonId,
            libraryId: this.config.libraryId,
            bunnyGuid: video.guid,
            collectionId,
            title,
            status: 'UPLOADING',
            declaredBytes: BigInt(Math.round(input.sizeBytes)),
            declaredSeconds: Math.ceil(input.durationSeconds),
            maxResolution: state.quota.maxResolution,
            createdById: input.userId,
          },
        }),
      )) as AssetRow;
    } catch (err) {
      // Sin fila no hay forma de llegar a ese vídeo: fuera de Bunny.
      await this.bunny.deleteVideo(video.guid).catch(() => undefined);
      throw err;
    }
    this.quotaCache.delete(tenantId);

    await this.audit(tenantId, input.userId, 'video.upload.created', row.id, {
      guid: video.guid,
      lessonId: input.lessonId,
      sizeBytes: input.sizeBytes,
      declaredSeconds: row.declaredSeconds,
      maxResolution: row.maxResolution,
      tier: state.quota.tier,
    });
    return { asset: this.view(row), upload: this.ticket(row) };
  }

  /** Firma nueva para reanudar una subida (otra pestaña, o pasadas 24 h). */
  async resign(tenantId: string, assetId: string): Promise<TusUploadTicket> {
    const row = await this.findAsset(tenantId, assetId);
    if (row.status !== 'UPLOADING' || row.deletedAt) {
      throw new VideoCloudError(
        'VIDEO_UPLOAD_NOT_RESUMABLE',
        409,
        'Esta subida ya terminó o se canceló.',
      );
    }
    return this.ticket(row);
  }

  async getAsset(tenantId: string, assetId: string): Promise<VideoAssetView> {
    let row = await this.findAsset(tenantId, assetId);
    // Mientras codifica se pregunta a Bunny: si el webhook no llegó (o aún no
    // está configurado), el editor no se queda esperando para siempre.
    if (row.status === 'UPLOADING' || row.status === 'PROCESSING') {
      await this.refresh(tenantId, row.bunnyGuid).catch((err: unknown) =>
        this.logger.warn(`No se pudo consultar ${row.bunnyGuid}: ${(err as Error).message}`),
      );
      row = await this.findAsset(tenantId, assetId);
    }
    return this.view(row);
  }

  async listForLesson(tenantId: string, lessonId: string): Promise<VideoAssetView[]> {
    const rows = (await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.findMany({
        where: { tenantId, lessonId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    )) as AssetRow[];
    return rows.map((r) => this.view(r));
  }

  /**
   * Borrado a petición del creador (cancelar una subida, quitar un vídeo que
   * aún no ha guardado en la lección). Un vídeo que una lección ya usa no se
   * borra por aquí: primero se quita de la lección y se guarda.
   */
  async deleteAsset(tenantId: string, userId: string, assetId: string): Promise<void> {
    const row = await this.findAsset(tenantId, assetId);
    if (row.deletedAt) return;
    const referenced = await this.referencedGuids(tenantId, [row.bunnyGuid]);
    if (referenced.has(row.bunnyGuid)) {
      throw new VideoCloudError(
        'VIDEO_UPLOAD_IN_USE',
        409,
        'Este vídeo está en una lección. Quítalo de la lección y guarda antes de borrarlo.',
      );
    }
    await this.removeFromBunny(tenantId, row, 'removed', userId);
  }

  // ─────────────────────────── reproducción ───────────────────────────

  async resolvePlay(input: {
    tenantId: string;
    guid: string;
    isEditor: boolean;
  }): Promise<CloudPlayDecision> {
    const guid = input.guid.toLowerCase();
    if (!BUNNY_GUID_RE.test(guid)) return { kind: 'not_ours' };
    const row = await runAsTenant(input.tenantId, () =>
      this.prisma.videoAsset.findFirst({
        where: { tenantId: input.tenantId, bunnyGuid: guid, deletedAt: null },
        select: { id: true, status: true, lastPlayedAt: true },
      }),
    );
    if (!row || (row.status !== 'READY' && row.status !== 'PROCESSING')) {
      return { kind: 'not_ours' };
    }
    if (!input.isEditor) {
      const state = await this.quotaState(input.tenantId);
      if (watchQuotaExceeded(state.quota, state.watchedThisMonth)) {
        return { kind: 'watch_quota_exceeded' };
      }
      const nowMs = this.now().getTime();
      if (!row.lastPlayedAt || nowMs - row.lastPlayedAt.getTime() > PLAY_TOUCH_MS) {
        await runAsTenant(input.tenantId, () =>
          this.prisma.videoAsset.update({
            where: { id: row.id },
            data: { lastPlayedAt: new Date(nowMs) },
          }),
        ).catch(() => undefined);
      }
    }
    return { kind: 'ok', tokenKey: this.config.tokenKey };
  }

  // ─────────────────────── estado desde Bunny ───────────────────────

  /** De qué aula es un vídeo de la biblioteca. Lectura global sancionada. */
  async tenantOfGuid(guid: string): Promise<string | null> {
    const g = guid.toLowerCase();
    if (!BUNNY_GUID_RE.test(g)) return null;
    const row = await runGlobalWithoutTenant(() =>
      this.prisma.videoAsset.findUnique({ where: { bunnyGuid: g }, select: { tenantId: true } }),
    );
    return row?.tenantId ?? null;
  }

  /**
   * Aviso del webhook: solo dice «mira este vídeo». El estado se lee SIEMPRE
   * de la API de Bunny, así que un aviso repetido o fuera de orden no
   * estropea nada.
   */
  async handleWebhook(payload: {
    libraryId: number;
    guid: string;
  }): Promise<'applied' | 'ignored'> {
    if (String(payload.libraryId) !== this.config.libraryId) return 'ignored';
    const tenantId = await this.tenantOfGuid(payload.guid);
    if (!tenantId) return 'ignored';
    await this.refresh(tenantId, payload.guid.toLowerCase());
    return 'applied';
  }

  /** Lee el vídeo en Bunny y aplica lo que diga. Idempotente. */
  async refresh(tenantId: string, guid: string, known?: BunnyVideo | null): Promise<void> {
    const row = (await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.findFirst({ where: { tenantId, bunnyGuid: guid } }),
    )) as AssetRow | null;
    if (!row || row.deletedAt) return;

    const video = known === undefined ? await this.bunny.getVideo(guid) : known;
    if (!video) {
      await this.markDeleted(tenantId, row, 'bunny', null);
      return;
    }
    const next = statusFromBunny(video.status);
    const data: Record<string, unknown> = {
      status: next,
      durationSeconds: video.length > 0 ? Math.round(video.length) : row.durationSeconds,
      storageBytes: BigInt(Math.max(0, Math.round(video.storageSize))),
      availableResolutions: video.availableResolutions,
      lastSyncedAt: this.now(),
    };

    if (next === 'FAILED') {
      await this.bunny.deleteVideo(guid).catch(() => undefined);
      await runAsTenant(tenantId, () =>
        this.prisma.videoAsset.update({
          where: { id: row.id },
          data: {
            ...data,
            failureReason:
              video.status === BUNNY_VIDEO_STATUS.UPLOAD_FAILED
                ? 'upload_failed'
                : 'encoding_failed',
            deletedAt: this.now(),
            deleteReason: 'failed',
          },
        }),
      );
      this.quotaCache.delete(tenantId);
      await this.audit(tenantId, null, 'video.upload.failed', row.id, {
        guid,
        bunnyStatus: video.status,
      });
      return;
    }

    if (next === 'READY' && row.status !== 'READY') {
      const verdict = await this.checkFinished(tenantId, row, video);
      if (verdict !== 'ok') {
        await this.bunny.deleteVideo(guid).catch(() => undefined);
        await runAsTenant(tenantId, () =>
          this.prisma.videoAsset.update({
            where: { id: row.id },
            data: {
              ...data,
              status: 'FAILED',
              failureReason: verdict,
              deletedAt: this.now(),
              deleteReason: verdict,
            },
          }),
        );
        this.quotaCache.delete(tenantId);
        await this.audit(tenantId, null, 'video.upload.rejected', row.id, {
          guid,
          reason: verdict,
          lengthSeconds: video.length,
        });
        return;
      }
    }

    if (next === 'READY' && !row.resolutionsCapped) {
      const capped = await this.capResolutions(tenantId, row, video);
      if (capped) {
        data['resolutionsCapped'] = true;
        data['availableResolutions'] = capped.remaining;
      }
    }

    await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.update({ where: { id: row.id }, data }),
    );
    if (next !== row.status) this.quotaCache.delete(tenantId);
  }

  /** ¿Se queda el vídeo ya codificado? Duración real y cuota del aula. */
  private async checkFinished(
    tenantId: string,
    row: AssetRow,
    video: BunnyVideo,
  ): Promise<'ok' | 'too_long' | 'quota'> {
    const state = await this.quotaState(tenantId, { fresh: true });
    const mine = row.durationSeconds ?? row.declaredSeconds;
    return checkEncoded({
      quota: state.quota,
      usedOthersSeconds: Math.max(0, state.usedSeconds - mine),
      lengthSeconds: Math.round(video.length),
    });
  }

  /**
   * Antes de la primera venta el máximo es 720p: la biblioteca codifica hasta
   * 1080p y aquí se borran las resoluciones de más. Si entre subir y terminar
   * de codificar el aula ya ha vendido, se queda con todo.
   */
  private async capResolutions(
    tenantId: string,
    row: AssetRow,
    video: BunnyVideo,
  ): Promise<{ remaining: string | null } | null> {
    if (row.maxResolution !== '720p') return null;
    const state = await this.quotaState(tenantId);
    if (state.quota.maxResolution !== '720p') return { remaining: video.availableResolutions };
    const available = (video.availableResolutions ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    const above = available.filter((r) =>
      (RESOLUTIONS_ABOVE_720P as readonly string[]).includes(r),
    );
    if (above.length > 0) {
      try {
        await this.bunny.deleteResolutions(row.bunnyGuid, above);
      } catch (err) {
        // Se reintentará en el siguiente refresco: no se marca como hecho.
        this.logger.warn(
          `No se pudieron quitar ${above.join(',')} de ${row.bunnyGuid}: ${(err as Error).message}`,
        );
        return null;
      }
      await this.audit(tenantId, null, 'video.upload.resolutions_capped', row.id, {
        guid: row.bunnyGuid,
        removed: above,
      });
    }
    const remaining = available.filter((r) => !above.includes(r)).join(',') || null;
    return { remaining };
  }

  // ─────────────────────────── barrido horario ───────────────────────────

  /** Aulas con colección en Bunny que no se han purgado. Lectura global sancionada. */
  async tenantsWithVideo(): Promise<string[]> {
    const rows = await runGlobalWithoutTenant(() =>
      this.prisma.videoTenantState.findMany({
        where: { collectionId: { not: null }, purgedAt: null },
        select: { tenantId: true },
      }),
    );
    return rows.map((r) => r.tenantId);
  }

  /**
   * Por aula, una vez por hora:
   *  1. Estado de cada vídeo según Bunny (red de seguridad del webhook).
   *  2. Horas vistas: lo que ha crecido el `totalWatchTime` de cada vídeo se
   *     suma al mes en curso.
   *  3. Vídeos que ninguna lección usa (sustituidos o quitados) → fuera de
   *     Bunny pasado el margen.
   *  4. Subidas abandonadas y vídeos de la colección que no están en la base
   *     de datos → fuera de Bunny.
   */
  async reconcileTenant(tenantId: string): Promise<{
    refreshed: number;
    watchedAddedSeconds: number;
    deleted: number;
  }> {
    const state = await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.findUnique({ where: { tenantId } }),
    );
    if (!state?.collectionId || state.purgedAt) {
      return { refreshed: 0, watchedAddedSeconds: 0, deleted: 0 };
    }

    const bunnyVideos = new Map<string, BunnyVideo>();
    for (let page = 1; page <= 50; page++) {
      const res = await this.bunny.listVideos({
        collectionId: state.collectionId,
        page,
        itemsPerPage: 1000,
      });
      for (const v of res.items) bunnyVideos.set(v.guid, v);
      if (res.items.length < 1000 || bunnyVideos.size >= res.totalItems) break;
    }

    const rows = (await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.findMany({ where: { tenantId, deletedAt: null } }),
    )) as AssetRow[];
    const known = new Set<string>();
    let refreshed = 0;
    let watchedAddedSeconds = 0;
    let deleted = 0;
    const nowMs = this.now().getTime();

    for (const row of rows) {
      known.add(row.bunnyGuid);
      const video = bunnyVideos.get(row.bunnyGuid) ?? null;
      try {
        // El listado puede ir por detrás de un vídeo recién creado: si no
        // sale, se le pregunta a Bunny directamente antes de darlo por borrado.
        await this.refresh(tenantId, row.bunnyGuid, video ?? undefined);
        refreshed++;
        if (video && video.totalWatchTime > Number(row.watchSecondsTotal)) {
          watchedAddedSeconds += await this.addWatchTime(tenantId, row, video.totalWatchTime);
        }
      } catch (err) {
        this.logger.warn(`No se pudo refrescar ${row.bunnyGuid}: ${(err as Error).message}`);
      }
    }

    // Lo que sigue vivo tras refrescar.
    const live = (await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.findMany({
        where: { tenantId, deletedAt: null, status: { in: [...LIVE_STATUSES] } },
      }),
    )) as AssetRow[];
    const referenced = await this.referencedGuids(
      tenantId,
      live.map((r) => r.bunnyGuid),
    );
    const referencedByLesson = await this.lessonsReferencing(tenantId, live);

    for (const row of live) {
      const bunnyStatus = bunnyVideos.get(row.bunnyGuid)?.status;
      if (
        row.status === 'UPLOADING' &&
        nowMs - row.createdAt.getTime() > ABANDONED_UPLOAD_MS &&
        (bunnyStatus === undefined || bunnyStatus === BUNNY_VIDEO_STATUS.CREATED)
      ) {
        if (await this.tryRemove(tenantId, row, 'abandoned')) deleted++;
        continue;
      }
      if (referenced.has(row.bunnyGuid)) {
        if (row.unreferencedSince) {
          await runAsTenant(tenantId, () =>
            this.prisma.videoAsset.update({
              where: { id: row.id },
              data: { unreferencedSince: null },
            }),
          );
        }
        continue;
      }
      if (!row.unreferencedSince) {
        await runAsTenant(tenantId, () =>
          this.prisma.videoAsset.update({
            where: { id: row.id },
            data: { unreferencedSince: new Date(nowMs) },
          }),
        );
        continue;
      }
      if (
        nowMs - row.unreferencedSince.getTime() >= UNREFERENCED_GRACE_MS &&
        nowMs - row.createdAt.getTime() >= NEW_UPLOAD_GRACE_MS
      ) {
        // «Sustituido» si su lección ya usa otro vídeo subido; si no, «quitado».
        const reason =
          row.lessonId && referencedByLesson.has(row.lessonId) ? 'replaced' : 'removed';
        if (await this.tryRemove(tenantId, row, reason)) deleted++;
      }
    }

    // Vídeos de NUESTRA colección sin fila (el alta falló a medias).
    for (const [guid, video] of bunnyVideos) {
      if (known.has(guid)) continue;
      const age = video.dateUploadedMs === null ? Infinity : nowMs - video.dateUploadedMs;
      if (age < ORPHAN_GRACE_MS) continue;
      const owner = await this.tenantOfGuid(guid);
      if (owner) continue;
      await this.bunny.deleteVideo(guid).catch(() => undefined);
      await this.audit(tenantId, null, 'video.upload.orphan_deleted', guid, { guid });
      deleted++;
    }

    return { refreshed, watchedAddedSeconds, deleted };
  }

  /** Un fallo de Bunny con un vídeo no para el barrido: se reintenta en el siguiente. */
  private async tryRemove(tenantId: string, row: AssetRow, reason: string): Promise<boolean> {
    try {
      await this.removeFromBunny(tenantId, row, reason, null);
      return true;
    } catch (err) {
      this.logger.warn(`Bunny no borró ${row.bunnyGuid} (${reason}): ${(err as Error).message}`);
      return false;
    }
  }

  private async addWatchTime(tenantId: string, row: AssetRow, total: number): Promise<number> {
    const delta = Math.max(0, Math.round(total) - Number(row.watchSecondsTotal));
    if (delta === 0) return 0;
    const month = monthKey(this.now());
    await runAsTenant(tenantId, () =>
      this.prisma.$transaction([
        this.prisma.videoAsset.update({
          where: { id: row.id },
          data: { watchSecondsTotal: BigInt(Math.round(total)) },
        }),
        this.prisma.videoUsageMonth.upsert({
          where: { tenantId_month: { tenantId, month } },
          create: { tenantId, month, watchedSeconds: BigInt(delta) },
          update: { watchedSeconds: { increment: BigInt(delta) } },
        }),
      ]),
    );
    this.quotaCache.delete(tenantId);
    return delta;
  }

  // ─────────────────────────── borrado ───────────────────────────

  /**
   * Borra el vídeo en Bunny y lo marca borrado. Si Bunny falla, NO se marca:
   * el siguiente barrido lo vuelve a intentar (un vídeo marcado como borrado
   * que sigue en Bunny costaría para siempre sin que nadie lo vea).
   */
  async removeFromBunny(
    tenantId: string,
    row: { id: string; bunnyGuid: string; status: string },
    reason: string,
    actorId: string | null,
  ): Promise<void> {
    await this.bunny.deleteVideo(row.bunnyGuid);
    await this.markDeleted(tenantId, row, reason, actorId);
  }

  private async markDeleted(
    tenantId: string,
    row: { id: string; bunnyGuid: string; status: string },
    reason: string,
    actorId: string | null,
  ): Promise<void> {
    await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.update({
        where: { id: row.id },
        data: {
          status: 'DELETED',
          deletedAt: this.now(),
          deleteReason: reason,
          ...(row.status === 'UPLOADING' && reason === 'abandoned'
            ? { failureReason: 'abandoned' }
            : {}),
        },
      }),
    );
    this.quotaCache.delete(tenantId);
    await this.audit(tenantId, actorId, 'video.upload.deleted', row.id, {
      guid: row.bunnyGuid,
      reason,
    });
  }

  // ─────────────────────────── colección ───────────────────────────

  /**
   * La colección `DC_<slug>` del aula, creada al primer uso. Idempotente:
   * reutiliza la que ya exista en Bunny con ese nombre, y una reserva en la
   * base de datos evita que dos subidas a la vez creen dos.
   */
  async ensureCollection(tenantId: string): Promise<string> {
    const existing = await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.upsert({
        where: { tenantId },
        create: { tenantId },
        update: {},
      }),
    );
    if (existing.collectionId) return existing.collectionId;

    const nowMs = this.now().getTime();
    const claimed = await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.updateMany({
        where: {
          tenantId,
          collectionId: null,
          OR: [
            { collectionClaimedAt: null },
            { collectionClaimedAt: { lt: new Date(nowMs - 2 * 60_000) } },
          ],
        },
        data: { collectionClaimedAt: new Date(nowMs) },
      }),
    );
    if (claimed.count === 0) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const s = await runAsTenant(tenantId, () =>
          this.prisma.videoTenantState.findUnique({ where: { tenantId } }),
        );
        if (s?.collectionId) return s.collectionId;
      }
      throw new VideoCloudError(
        'VIDEO_UPLOAD_BUSY',
        409,
        'Se está preparando el espacio de vídeo de tu academia. Inténtalo de nuevo en unos segundos.',
      );
    }

    // `tenant` no lleva RLS: es el registro de aulas.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    if (!tenant)
      throw new VideoCloudError('VIDEO_UPLOAD_LESSON_NOT_FOUND', 404, 'Aula no encontrada.');
    const name = collectionNameFor(tenant.slug);
    try {
      const found = (await this.bunny.listCollections(name)).find((c) => c.name === name);
      const collection = found ?? (await this.bunny.createCollection(name));
      await runAsTenant(tenantId, () =>
        this.prisma.videoTenantState.update({
          where: { tenantId },
          data: { collectionId: collection.guid, collectionName: name },
        }),
      );
      await this.audit(tenantId, null, 'video.collection.ready', collection.guid, {
        name,
        reused: Boolean(found),
      });
      return collection.guid;
    } catch (err) {
      await runAsTenant(tenantId, () =>
        this.prisma.videoTenantState.update({
          where: { tenantId },
          data: { collectionClaimedAt: null },
        }),
      ).catch(() => undefined);
      if (err instanceof VideoCloudError) throw err;
      this.logger.error(`Bunny no creó la colección ${name}: ${(err as Error).message}`);
      throw new VideoCloudError(
        'VIDEO_UPLOAD_PROVIDER_ERROR',
        502,
        'No se pudo preparar la subida. Inténtalo de nuevo en un momento.',
      );
    }
  }

  // ─────────────────────────── ayudas ───────────────────────────

  /**
   * GUIDs (de la lista) que aparecen en alguna lección viva del aula o en el
   * vídeo destacado de un curso. Lectura de mod.courses filtrada por tenant;
   * consulta cruda en `$transaction` por lotes para que lleve el contexto de
   * RLS (ver `VideoAccessService`).
   */
  async referencedGuids(tenantId: string, guids: string[]): Promise<Set<string>> {
    const clean = [...new Set(guids.map((g) => g.toLowerCase()))].filter((g) =>
      BUNNY_GUID_RE.test(g),
    );
    if (clean.length === 0) return new Set();
    const [rows] = await runAsTenant(tenantId, () =>
      this.prisma.$transaction([
        this.prisma.$queryRaw<Array<{ guid: string }>>`
          SELECT g.guid
            FROM unnest(${clean}::text[]) AS g(guid)
           WHERE EXISTS (
                   SELECT 1
                     FROM mod_courses_lesson l
                     JOIN mod_courses_module m ON m.id = l.module_id AND m.deleted_at IS NULL
                     JOIN mod_courses_course c ON c.id = m.course_id AND c.deleted_at IS NULL
                    WHERE l.tenant_id = ${tenantId}::uuid
                      AND l.deleted_at IS NULL
                      AND l.content::text ILIKE '%' || g.guid || '%')
              OR EXISTS (
                   SELECT 1
                     FROM mod_courses_course c2
                    WHERE c2.tenant_id = ${tenantId}::uuid
                      AND c2.deleted_at IS NULL
                      AND c2.featured_video_url ILIKE '%' || g.guid || '%')`,
      ]),
    );
    return new Set(rows.map((r) => r.guid));
  }

  /** Lecciones (de estos vídeos) cuyo contenido usa OTRO vídeo subido. */
  private async lessonsReferencing(tenantId: string, live: AssetRow[]): Promise<Set<string>> {
    const lessonIds = [...new Set(live.map((r) => r.lessonId).filter((x): x is string => !!x))];
    if (lessonIds.length === 0) return new Set();
    const lessons = await runAsTenant(tenantId, () =>
      this.prisma.modCoursesLesson.findMany({
        where: { tenantId, id: { in: lessonIds }, deletedAt: null },
        select: { id: true, content: true },
      }),
    );
    const allGuids = live.map((r) => r.bunnyGuid);
    const out = new Set<string>();
    for (const l of lessons) {
      const text = JSON.stringify(l.content ?? {}).toLowerCase();
      if (allGuids.some((g) => text.includes(g))) out.add(l.id);
    }
    return out;
  }

  private async findAsset(tenantId: string, assetId: string): Promise<AssetRow> {
    const row = (await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.findFirst({ where: { id: assetId, tenantId } }),
    )) as AssetRow | null;
    if (!row) throw new VideoCloudError('VIDEO_UPLOAD_NOT_FOUND', 404, 'Vídeo no encontrado.');
    return row;
  }

  private ticket(row: AssetRow): TusUploadTicket {
    const expires = Math.floor(this.now().getTime() / 1000) + TUS_SIGNATURE_TTL_SECONDS;
    return {
      endpoint: this.config.tusEndpoint,
      headers: {
        AuthorizationSignature: bunnyTusSignature({
          libraryId: this.config.libraryId,
          apiKey: this.config.apiKey,
          expiresUnix: expires,
          videoId: row.bunnyGuid,
        }),
        AuthorizationExpire: String(expires),
        VideoId: row.bunnyGuid,
        LibraryId: this.config.libraryId,
      },
      metadata: {
        filetype: 'video/mp4',
        title: row.title,
        collection: row.collectionId ?? '',
      },
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  view(row: AssetRow): VideoAssetView {
    const ready = row.status === 'READY' && !row.deletedAt;
    return {
      id: row.id,
      lessonId: row.lessonId,
      title: row.title,
      status: row.status,
      failureReason: row.failureReason,
      durationSeconds: row.durationSeconds,
      maxResolution: row.maxResolution,
      embedUrl: bunnyEmbedBaseUrl(row.libraryId, row.bunnyGuid),
      thumbnailUrl: ready
        ? signBunnyCdnUrl({
            url: `https://${this.config.cdnHostname}/${row.bunnyGuid}/thumbnail.jpg`,
            securityKey: this.config.tokenKey,
            expiresUnix: Math.floor(this.now().getTime() / 1000) + 3600,
          })
        : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async audit(
    tenantId: string,
    actorId: string | null,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await runAsTenant(tenantId, () =>
        this.auditLog.record({
          tenantId,
          actorId,
          action,
          resourceType: 'video_asset',
          resourceId,
          metadata,
        }),
      );
    } catch (err) {
      this.logger.warn(`No se pudo auditar ${action}: ${(err as Error).message}`);
    }
  }
}
