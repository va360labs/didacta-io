/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import type { GoogleDriveClient } from './google-drive.client';
import { openBunnyHls, type HlsSource } from './hls-download';
import type { VideoCloudEnabled } from './video-cloud.config';
import { collectionNameFor, type VideoCloudService } from './video-cloud.service';
import { costAlert, monthKey } from './video-quota-policy';

/**
 * Política de inactividad del vídeo de Didacta Cloud (decidida por el dueño):
 *
 *  - Actividad = entra el creador, entra o ve algo un alumno, hay una venta o
 *    hay una suscripción viva.
 *  - A los 10 y a los 20 días sin actividad: correo al creador.
 *  - A los 30: copia de los vídeos a Google Drive, borrado en Bunny y aula
 *    ARCHIVADA (no borrada). La copia se guarda 90 días y luego se borra; una
 *    petición de supresión (RGPD) la borra antes.
 *
 * Salvaguardas (ninguna se puede saltar):
 *  - Sin copia CONFIRMADA en Drive no se borra ningún vídeo ya codificado. Sin
 *    la credencial de Drive la política corre en seco: avisa, calcula y
 *    audita, pero no borra ni archiva.
 *  - Entre un aviso y el siguiente, y entre el último aviso y el borrado, pasan
 *    al menos 10 días: un aula que ya estaba parada cuando se encendió esto, o
 *    a la que no le llegó un correo, no pierde nada sin aviso.
 *  - Un aviso solo cuenta como dado si salió al menos un correo.
 *  - Cualquier actividad nueva reinicia el ciclo.
 *  - Todo es idempotente: si el barrido se corta a medias, el siguiente sigue
 *    donde se quedó (lo copiado no se vuelve a copiar; lo borrado no se vuelve
 *    a borrar).
 */

const DAY_MS = 24 * 3600_000;
export const INACTIVITY = {
  firstWarningDays: 10,
  secondWarningDays: 20,
  purgeDays: 30,
  /** Mínimo entre avisos y entre el último aviso y el borrado. */
  minNoticeDays: 10,
  backupRetentionDays: 90,
} as const;

/** Igual que `jwtRefreshTtlSeconds` (auth.config.ts): cada refresco la alarga 30 días. */
const REFRESH_TTL_MS = 30 * DAY_MS;

export interface VideoInactivityNotifier {
  /** Avisa a los administradores del aula. Devuelve cuántos correos salieron. */
  warnCreator(input: { tenantId: string; stage: 10 | 20; deleteOn: Date }): Promise<number>;
  /** Alerta al operador (siempre al log; al correo si hay). */
  operatorAlert(alert: string, detail: Record<string, unknown>): Promise<void>;
}

/** Archiva el aula (lo mismo que el panel del operador: cierra sesiones, cobros…). */
export interface TenantArchiver {
  archive(tenantId: string, metadata: Record<string, unknown>): Promise<void>;
}

export type HlsOpener = (input: { guid: string }) => Promise<HlsSource>;

export interface ActivityResult {
  at: Date;
  source: string;
}

export interface DailyResult {
  tenants: number;
  warned10: number;
  warned20: number;
  purged: number;
  blocked: number;
  dryRun: number;
  backupsExpired: number;
  costAlerts: number;
}

interface LiveAsset {
  id: string;
  bunnyGuid: string;
  title: string;
  status: string;
  backupDriveFileId: string | null;
  backupDeletedAt: Date | null;
}

/** Tiene una copia en Drive que sigue existiendo. */
function hasBackup(a: LiveAsset): boolean {
  return Boolean(a.backupDriveFileId) && !a.backupDeletedAt;
}

export class VideoInactivityService {
  private readonly logger = new Logger(VideoInactivityService.name);
  private readonly now: () => Date;
  private readonly openHls: HlsOpener;

  constructor(
    private readonly config: VideoCloudEnabled,
    private readonly prisma: PrismaService,
    private readonly cloud: VideoCloudService,
    private readonly drive: GoogleDriveClient | null,
    private readonly notifier: VideoInactivityNotifier,
    private readonly archiver: TenantArchiver,
    opts: { now?: () => Date; openHls?: HlsOpener } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.openHls =
      opts.openHls ??
      ((input) =>
        openBunnyHls({
          cdnHostname: config.cdnHostname,
          guid: input.guid,
          tokenKey: config.tokenKey,
        }));
  }

  /** El barrido diario completo. */
  async runDaily(): Promise<DailyResult> {
    const result: DailyResult = {
      tenants: 0,
      warned10: 0,
      warned20: 0,
      purged: 0,
      blocked: 0,
      dryRun: 0,
      backupsExpired: 0,
      costAlerts: 0,
    };
    result.backupsExpired = await this.expireBackups();
    for (const tenantId of await this.cloud.tenantsWithVideo()) {
      result.tenants++;
      try {
        const outcome = await this.evaluateTenant(tenantId);
        if (outcome === 'warned10') result.warned10++;
        else if (outcome === 'warned20') result.warned20++;
        else if (outcome === 'purged') result.purged++;
        else if (outcome === 'blocked') result.blocked++;
        else if (outcome === 'dry_run') result.dryRun++;
        if (await this.checkCost(tenantId)) result.costAlerts++;
      } catch (err) {
        this.logger.error(`Inactividad de vídeo, aula ${tenantId}: ${(err as Error).message}`);
      }
    }
    return result;
  }

  // ─────────────────────────── actividad ───────────────────────────

  /**
   * Última actividad del aula: el máximo de todas las fuentes. Una
   * suscripción viva cuenta como actividad AHORA.
   */
  async lastActivity(tenantId: string, tenantCreatedAt: Date): Promise<ActivityResult> {
    const now = this.now();
    return runAsTenant(tenantId, async () => {
      const [users, sessions, progress, videos, sales, liveSubs] = await Promise.all([
        this.prisma.user.aggregate({
          where: { tenantId, deletedAt: null },
          _max: { lastLoginAt: true },
        }),
        this.prisma.session.aggregate({
          where: { tenantId, revokedAt: null },
          _max: { createdAt: true, expiresAt: true },
        }),
        this.prisma.modLearningProgress.aggregate({
          where: { tenantId },
          _max: { lastAccessedAt: true },
        }),
        this.prisma.videoAsset.aggregate({
          where: { tenantId },
          _max: { lastPlayedAt: true, createdAt: true },
        }),
        this.prisma.modPayoutsSale.aggregate({
          where: { tenantId, chargedAt: { not: null } },
          _max: { chargedAt: true },
        }),
        this.prisma.modSubscriptionsSubscription.count({
          where: { tenantId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
        }),
      ]);
      if (liveSubs > 0) return { at: now, source: 'subscription' };

      // Una sesión que se refresca alarga su caducidad a «ahora + 30 días»:
      // restarle eso da cuándo se usó por última vez sin tener que escribir
      // nada en cada petición.
      const refreshedAt = sessions._max.expiresAt
        ? new Date(Math.min(sessions._max.expiresAt.getTime() - REFRESH_TTL_MS, now.getTime()))
        : null;
      const candidates: Array<[Date | null | undefined, string]> = [
        [tenantCreatedAt, 'created'],
        [users._max.lastLoginAt, 'login'],
        [sessions._max.createdAt, 'login'],
        [refreshedAt, 'session'],
        [progress._max.lastAccessedAt, 'progress'],
        [videos._max.lastPlayedAt, 'play'],
        [videos._max.createdAt, 'upload'],
        [sales._max.chargedAt, 'sale'],
      ];
      let best: ActivityResult = { at: tenantCreatedAt, source: 'created' };
      for (const [at, source] of candidates) {
        if (at && at.getTime() > best.at.getTime()) best = { at, source };
      }
      if (best.at.getTime() > now.getTime()) best = { at: now, source: best.source };
      return best;
    });
  }

  // ─────────────────────────── por aula ───────────────────────────

  async evaluateTenant(
    tenantId: string,
  ): Promise<
    'active' | 'skipped' | 'waiting' | 'warned10' | 'warned20' | 'purged' | 'blocked' | 'dry_run'
  > {
    const now = this.now();
    // `tenant` no lleva RLS: es el registro de aulas.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, deletedAt: true, createdAt: true },
    });
    if (!tenant || tenant.deletedAt || tenant.status !== 'ACTIVE') return 'skipped';

    const live = await this.liveAssets(tenantId);
    const state = await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.upsert({
        where: { tenantId },
        create: { tenantId },
        update: {},
      }),
    );
    if (live.length === 0 && !state.purgeStartedAt) return 'skipped';

    const activity = await this.lastActivity(tenantId, tenant.createdAt);
    const idleDays = (now.getTime() - activity.at.getTime()) / DAY_MS;
    const recovered = idleDays < INACTIVITY.firstWarningDays;

    await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.update({
        where: { tenantId },
        data: {
          lastActivityAt: activity.at,
          lastActivitySource: activity.source,
          ...(recovered &&
          (state.warned10At || state.warned20At || state.purgeBlockedReason || state.purgeStartedAt)
            ? { warned10At: null, warned20At: null, purgeBlockedReason: null, purgeStartedAt: null }
            : {}),
        },
      }),
    );
    if (recovered) {
      if (state.warned10At) {
        await this.cloud.audit(tenantId, null, 'video.inactivity.reset', tenantId, {
          lastActivityAt: activity.at.toISOString(),
          source: activity.source,
        });
      }
      return 'active';
    }

    const sinceDays = (d: Date | null) => (d ? (now.getTime() - d.getTime()) / DAY_MS : -1);
    const purgeOn = (minFromNow: number) =>
      new Date(
        Math.max(
          activity.at.getTime() + INACTIVITY.purgeDays * DAY_MS,
          now.getTime() + minFromNow * DAY_MS,
        ),
      );

    if (!state.warned10At) {
      const deleteOn = purgeOn(2 * INACTIVITY.minNoticeDays);
      const sent = await this.notifier.warnCreator({ tenantId, stage: 10, deleteOn });
      if (sent === 0) return 'waiting';
      await runAsTenant(tenantId, () =>
        this.prisma.videoTenantState.update({ where: { tenantId }, data: { warned10At: now } }),
      );
      await this.cloud.audit(tenantId, null, 'video.inactivity.warned', tenantId, {
        stage: 10,
        idleDays: Math.floor(idleDays),
        deleteOn: deleteOn.toISOString(),
        emails: sent,
      });
      return 'warned10';
    }

    if (!state.warned20At) {
      if (
        idleDays < INACTIVITY.secondWarningDays ||
        sinceDays(state.warned10At) < INACTIVITY.minNoticeDays
      ) {
        return 'waiting';
      }
      const deleteOn = purgeOn(INACTIVITY.minNoticeDays);
      const sent = await this.notifier.warnCreator({ tenantId, stage: 20, deleteOn });
      if (sent === 0) return 'waiting';
      await runAsTenant(tenantId, () =>
        this.prisma.videoTenantState.update({ where: { tenantId }, data: { warned20At: now } }),
      );
      await this.cloud.audit(tenantId, null, 'video.inactivity.warned', tenantId, {
        stage: 20,
        idleDays: Math.floor(idleDays),
        deleteOn: deleteOn.toISOString(),
        emails: sent,
      });
      return 'warned20';
    }

    if (idleDays < INACTIVITY.purgeDays || sinceDays(state.warned20At) < INACTIVITY.minNoticeDays) {
      return 'waiting';
    }
    return this.purgeTenant(tenantId, Math.floor(idleDays), activity);
  }

  /**
   * Copia, borrado y archivado. Sin la credencial de Drive se queda en seco.
   * Un fallo en la copia de CUALQUIER vídeo para todo el borrado del aula.
   */
  async purgeTenant(
    tenantId: string,
    idleDays: number,
    activity: ActivityResult,
  ): Promise<'purged' | 'blocked' | 'dry_run'> {
    const now = this.now();
    const live = await this.liveAssets(tenantId);

    if (!this.drive || !this.config.drive) {
      await this.block(tenantId, 'sin_copia: falta la credencial de Google Drive', {
        dryRun: true,
        idleDays,
        videos: live.length,
      });
      return 'dry_run';
    }

    await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.updateMany({
        where: { tenantId, purgeStartedAt: null },
        data: { purgeStartedAt: now },
      }),
    );

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    const prefix = collectionNameFor(tenant?.slug ?? tenantId);

    // 1. Copia de cada vídeo codificado que aún no la tenga.
    for (const asset of live) {
      if (asset.status !== 'READY' || hasBackup(asset)) continue;
      try {
        await this.backupAsset(tenantId, prefix, asset);
      } catch (err) {
        const message = (err as Error).message.slice(0, 250);
        await runAsTenant(tenantId, () =>
          this.prisma.videoAsset.update({
            where: { id: asset.id },
            data: { backupError: message },
          }),
        );
        await this.block(tenantId, `copia fallida de ${asset.bunnyGuid}: ${message}`, {
          guid: asset.bunnyGuid,
        });
        return 'blocked';
      }
    }

    // 2. Comprobación: ningún vídeo codificado sin copia.
    const pending = (await this.liveAssets(tenantId)).filter(
      (a) => a.status === 'READY' && !hasBackup(a),
    );
    if (pending.length > 0) {
      await this.block(tenantId, 'hay vídeos sin copia confirmada', { pending: pending.length });
      return 'blocked';
    }

    // 3. Borrado en Bunny (lo que no está codificado no tiene nada que copiar).
    let deleted = 0;
    for (const asset of await this.liveAssets(tenantId)) {
      try {
        await this.cloud.removeFromBunny(tenantId, asset, 'inactivity', null);
        deleted++;
      } catch (err) {
        await this.block(tenantId, `Bunny no borró ${asset.bunnyGuid}: ${(err as Error).message}`, {
          guid: asset.bunnyGuid,
        });
        return 'blocked';
      }
    }

    // 4. Archivado del aula.
    await this.archiver.archive(tenantId, {
      reason: 'video_inactivity',
      idleDays,
      lastActivityAt: activity.at.toISOString(),
      lastActivitySource: activity.source,
      videosDeleted: deleted,
    });
    await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.update({
        where: { tenantId },
        data: { purgedAt: now, archivedAt: now, purgeBlockedReason: null },
      }),
    );
    await this.cloud.audit(tenantId, null, 'video.inactivity.purged', tenantId, {
      idleDays,
      videosDeleted: deleted,
      lastActivityAt: activity.at.toISOString(),
    });
    return 'purged';
  }

  private async backupAsset(tenantId: string, prefix: string, asset: LiveAsset): Promise<void> {
    const drive = this.drive!;
    const folderId = this.config.drive!.folderId;
    const source = await this.openHls({ guid: asset.bunnyGuid });
    const ext = source.container === 'fmp4' ? 'mp4' : 'ts';
    const safeTitle =
      asset.title
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .slice(0, 120)
        .trim() || 'video';
    const result = await drive.upload({
      name: `${prefix}__${asset.bunnyGuid}__${safeTitle}.${ext}`,
      mimeType: ext === 'mp4' ? 'video/mp4' : 'video/mp2t',
      folderId,
      appProperties: {
        didactaTenantId: tenantId,
        didactaVideoGuid: asset.bunnyGuid,
        didactaAssetId: asset.id,
        didactaPurpose: 'inactivity-backup',
      },
      chunks: source.chunks,
    });
    if (result.bytes <= 0) throw new Error('la copia salió vacía');
    const now = this.now();
    await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.update({
        where: { id: asset.id },
        data: {
          backupDriveFileId: result.fileId,
          backupBytes: BigInt(result.bytes),
          backupAt: now,
          backupExpiresAt: new Date(now.getTime() + INACTIVITY.backupRetentionDays * DAY_MS),
          backupDeletedAt: null,
          backupError: null,
        },
      }),
    );
    await this.cloud.audit(tenantId, null, 'video.backup.created', asset.id, {
      guid: asset.bunnyGuid,
      bytes: result.bytes,
      resolution: source.resolution,
      segments: source.segmentCount,
    });
  }

  private async block(
    tenantId: string,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const state = await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.findUnique({ where: { tenantId } }),
    );
    const short = reason.slice(0, 300);
    if (state?.purgeBlockedReason === short) return; // ya auditado
    await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.update({
        where: { tenantId },
        data: { purgeBlockedReason: short },
      }),
    );
    this.logger.warn(`alert: video.inactivity.blocked aula=${tenantId} motivo=${short}`);
    await this.cloud.audit(tenantId, null, 'video.inactivity.blocked', tenantId, {
      reason: short,
      ...metadata,
    });
  }

  private async liveAssets(tenantId: string): Promise<LiveAsset[]> {
    return runAsTenant(tenantId, () =>
      this.prisma.videoAsset.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ['UPLOADING', 'PROCESSING', 'READY'] },
        },
        select: {
          id: true,
          bunnyGuid: true,
          title: true,
          status: true,
          backupDriveFileId: true,
          backupDeletedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  // ─────────────────────────── copias ───────────────────────────

  /** Borra las copias de Drive que han cumplido 90 días. */
  async expireBackups(): Promise<number> {
    if (!this.drive) return 0;
    const now = this.now();
    const due = await runGlobalWithoutTenant(() =>
      this.prisma.videoAsset.findMany({
        where: {
          backupDriveFileId: { not: null },
          backupDeletedAt: null,
          backupExpiresAt: { lte: now },
        },
        select: { tenantId: true },
        distinct: ['tenantId'],
      }),
    );
    let count = 0;
    for (const { tenantId } of due) {
      count += (await this.deleteBackups(tenantId, { onlyExpired: true, reason: 'retention' }))
        .deleted;
    }
    return count;
  }

  /**
   * Borra (definitivamente) las copias de Drive de un aula. Con
   * `onlyExpired: false` es la supresión a petición (RGPD): todas, ya.
   */
  async deleteBackups(
    tenantId: string,
    opts: {
      onlyExpired: boolean;
      reason: 'retention' | 'erasure_request';
      actorId?: string | null;
    },
  ): Promise<{ deleted: number; failed: number }> {
    const now = this.now();
    const rows = await runAsTenant(tenantId, () =>
      this.prisma.videoAsset.findMany({
        where: {
          tenantId,
          backupDriveFileId: { not: null },
          backupDeletedAt: null,
          ...(opts.onlyExpired ? { backupExpiresAt: { lte: now } } : {}),
        },
        select: { id: true, bunnyGuid: true, backupDriveFileId: true },
      }),
    );
    if (rows.length > 0 && !this.drive) {
      throw new Error('Hay copias en Google Drive pero falta la credencial para borrarlas.');
    }
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const outcome = await this.drive!.deleteFile(row.backupDriveFileId!);
        await runAsTenant(tenantId, () =>
          this.prisma.videoAsset.update({
            where: { id: row.id },
            data: { backupDeletedAt: now },
          }),
        );
        deleted++;
        await this.cloud.audit(tenantId, opts.actorId ?? null, 'video.backup.deleted', row.id, {
          guid: row.bunnyGuid,
          reason: opts.reason,
          alreadyGone: outcome === 'not_found',
        });
      } catch (err) {
        failed++;
        this.logger.error(
          `alert: video.backup.delete_failed aula=${tenantId} vídeo=${row.bunnyGuid}: ${(err as Error).message}`,
        );
      }
    }
    return { deleted, failed };
  }

  // ─────────────────────────── coste ───────────────────────────

  /**
   * Aviso al operador si el vídeo del aula cuesta más del 30 % de la comisión
   * que deja (una vez al mes por aula).
   */
  async checkCost(tenantId: string): Promise<boolean> {
    const state = await this.cloud.quotaState(tenantId, { fresh: true });
    if (state.quota.tier !== 'post_sale') return false;
    const now = this.now();
    const month = monthKey(now);
    const prev = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)));
    const [storage, usage, tenantState] = await runAsTenant(tenantId, () =>
      Promise.all([
        this.prisma.videoAsset.aggregate({
          where: { tenantId, deletedAt: null },
          _sum: { storageBytes: true },
        }),
        this.prisma.videoUsageMonth.findMany({
          where: { tenantId, month: { in: [month, prev] } },
          select: { watchedSeconds: true },
        }),
        this.prisma.videoTenantState.findUnique({ where: { tenantId } }),
      ]),
    );
    if (tenantState?.costAlertMonth === month) return false;
    const watched = Math.max(0, ...usage.map((u) => Number(u.watchedSeconds)));
    const cost = costAlert({
      storageBytes: Number(storage._sum.storageBytes ?? 0n),
      watchedSecondsMonth: watched,
      commission12mEur: state.commission12mEur,
    });
    if (!cost.alert) return false;
    const detail = {
      tenantId,
      month,
      estimatedCostEur: Number(cost.costEur.toFixed(2)),
      monthlyCommissionEur: Number(cost.commissionMonthEur.toFixed(2)),
      ratio: Number(cost.ratio.toFixed(2)),
    };
    this.logger.warn(`alert: video.cost_over_commission ${JSON.stringify(detail)}`);
    await this.notifier.operatorAlert('video.cost_over_commission', detail);
    await runAsTenant(tenantId, () =>
      this.prisma.videoTenantState.update({
        where: { tenantId },
        data: { costAlertMonth: month },
      }),
    );
    await this.cloud.audit(tenantId, null, 'video.cost_alert', tenantId, detail);
    return true;
  }
}
