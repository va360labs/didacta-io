'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  formatDuration,
  formatUsedDuration,
  usedPercent,
  videoUploadApi,
  type VideoQuota,
} from '@/lib/video-upload';

/** Las frases de la cuota, en llano. Las usa la tarjeta y el editor de la lección. */
export function useQuotaLines(quota: VideoQuota) {
  const t = useTranslations('formadorCursos.videoUpload.quota');
  const pre = quota.tier === 'pre_sale';
  const stored = pre
    ? t('storedPre', {
        used: formatUsedDuration(quota.stored.usedSeconds),
        limit: formatDuration(quota.stored.limitSeconds),
        post: formatDuration(quota.postSaleStoredSeconds),
      })
    : t('storedPost', {
        used: formatUsedDuration(quota.stored.usedSeconds),
        limit: formatDuration(quota.stored.limitSeconds),
      });
  const bonus =
    !pre && quota.stored.bonusSeconds > 0
      ? t('bonus', { bonus: formatDuration(quota.stored.bonusSeconds) })
      : null;
  const watched =
    quota.watched.limitSeconds !== null
      ? t('watchedPre', {
          used: formatUsedDuration(quota.watched.usedSeconds),
          limit: formatDuration(quota.watched.limitSeconds),
        })
      : t('watchedPost', { used: formatUsedDuration(quota.watched.usedSeconds) });
  const resolution = pre ? t('resolutionPre') : t('resolutionPost');
  return { stored, bonus, watched, resolution };
}

/**
 * Tarjeta «Tu espacio de vídeo» del panel del creador. Si la academia no tiene
 * subida de vídeo (instalación sin Didacta Cloud), no pinta nada.
 */
export function VideoQuotaCard() {
  const [quota, setQuota] = useState<VideoQuota | null>(null);
  useEffect(() => {
    let cancelled = false;
    videoUploadApi
      .quota()
      .then((q) => {
        if (!cancelled) setQuota(q);
      })
      .catch(() => {
        /* sin subida de vídeo o sin red: no se pinta */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!quota) return null;
  return <VideoQuotaPanel quota={quota} />;
}

export function VideoQuotaPanel({ quota }: { quota: VideoQuota }) {
  const t = useTranslations('formadorCursos.videoUpload.quota');
  const lines = useQuotaLines(quota);
  const storedPct = usedPercent(quota.stored.usedSeconds, quota.stored.limitSeconds);
  const watchedPct = usedPercent(quota.watched.usedSeconds, quota.watched.limitSeconds);
  const full = quota.stored.usedSeconds >= quota.stored.limitSeconds;
  return (
    <Card data-testid="video-quota">
      <CardContent className="space-y-4 p-6">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 place-items-center rounded-md"
            style={{ background: 'var(--didacta-info-bg)', color: 'var(--didacta-info-fg)' }}
          >
            <Icon name="video" size={16} />
          </span>
          <h2 className="font-display text-lg font-semibold">{t('title')}</h2>
        </div>

        <div className="space-y-1.5">
          <Progress
            value={storedPct}
            tone={storedPct >= 90 ? 'warn' : 'info'}
            label={t('storedAria')}
          />
          <p className="text-sm text-text">{lines.stored}</p>
          {lines.bonus ? <p className="text-xs text-text-muted">{lines.bonus}</p> : null}
          {full ? (
            <p className="text-sm font-medium text-danger-700">
              {quota.tier === 'pre_sale'
                ? t('fullPre', { post: formatDuration(quota.postSaleStoredSeconds) })
                : t('fullPost')}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          {quota.watched.limitSeconds !== null ? (
            <Progress
              value={watchedPct}
              tone={watchedPct >= 90 ? 'warn' : 'success'}
              label={t('watchedAria')}
            />
          ) : null}
          <p className="text-sm text-text-muted">{lines.watched}</p>
        </div>

        <p className="text-xs text-text-subtle">{lines.resolution}</p>
      </CardContent>
    </Card>
  );
}
