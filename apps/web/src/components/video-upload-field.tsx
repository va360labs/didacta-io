'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useRef, useState, type DragEvent } from 'react';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useQuotaLines } from '@/components/video-quota';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { useVideoQuota, useVideoUpload, type UploadProblem } from '@/lib/use-video-upload';
import { formatSeconds } from '@/lib/video';
import {
  formatBytes,
  formatDuration,
  formatUsedDuration,
  type VideoAsset,
  type VideoQuota,
} from '@/lib/video-upload';

/** El motivo de un fallo de subida, en llano (lo usan los dos editores). */
export function useUploadProblemText(): (problem: UploadProblem) => string {
  const t = useTranslations('formadorCursos.videoUpload');
  const tErrors = useTranslations('errors');
  return (p) => {
    switch (p.kind) {
      case 'noDuration':
        return t('errors.noDuration');
      case 'notVideo':
        return t('errors.notVideo');
      case 'tooBig':
        return t('errors.tooBig', {
          size: formatBytes(p.sizeBytes),
          limit: formatBytes(p.limitBytes),
        });
      case 'tooLong':
        return t('errors.tooLong', {
          duration: formatUsedDuration(p.durationSeconds),
          limit: formatDuration(p.limitSeconds),
        });
      case 'noRoom':
        return t('errors.noRoom', {
          duration: formatUsedDuration(p.durationSeconds),
          free: formatDuration(p.freeSeconds),
        });
      case 'api':
        return apiErrorMessage(p.error, tErrors);
      case 'failed':
        return p.reason === 'tooLong'
          ? t('failed.tooLong', { limit: formatDuration(p.limitSeconds) })
          : t(`failed.${p.reason}`);
      default:
        return t('errors.generic');
    }
  };
}

/**
 * «Subir vídeo» en el editor de una lección de vídeo (modo completo):
 * arrastrar o elegir el fichero, progreso con pausa y reanudar, y el estado
 * del procesado. Al terminar de subir, rellena el enlace de la lección con el
 * del vídeo subido.
 *
 * Si la academia no tiene subida de vídeo (sin Didacta Cloud) no pinta nada y
 * el editor se queda solo con el campo del enlace, como siempre. El modo
 * sencillo tiene su propia maqueta (`SimpleVideoField`) sobre la misma lógica.
 */
export function VideoUploadField({
  lessonId,
  videoUrl,
  savedVideoUrl,
  onVideoUrl,
  onDuration,
}: {
  lessonId: string;
  /** El enlace del formulario (aún sin guardar). */
  videoUrl: string;
  /** El enlace guardado en la lección. */
  savedVideoUrl: string;
  onVideoUrl: (url: string) => void;
  /** Duración real (minutos) cuando el vídeo está listo, para la ficha de la lección. */
  onDuration?: (minutes: number) => void;
}) {
  const t = useTranslations('formadorCursos.videoUpload');
  const problemText = useUploadProblemText();
  const { state, refresh } = useVideoQuota();
  const quota = state.kind === 'on' ? state.quota : null;
  const up = useVideoUpload({
    quota,
    refreshQuota: refresh,
    lessonId,
    videoUrl,
    savedVideoUrl,
    onVideoUrl,
    onDuration,
  });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { phase, current: shown, attached, busy } = up;

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void up.handleFile(file);
  }

  if (!quota) return null;

  const inputId = `video-upload-${lessonId}`;

  return (
    <div className="space-y-3" data-testid="video-upload">
      {shown && attached ? (
        <UploadedCard
          asset={shown}
          processing={shown.status !== 'READY'}
          unsaved={savedVideoUrl !== shown.embedUrl}
          onReplace={() => inputRef.current?.click()}
          onRemove={() => onVideoUrl('')}
        />
      ) : null}

      {phase.kind === 'uploading' ? (
        <div
          className="space-y-2 rounded-lg border border-border bg-surface-2 p-4"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-semibold text-text">{phase.asset.title}</p>
            <span className="shrink-0 text-xs tabular-nums text-text-muted">
              {Math.floor((phase.sent / Math.max(1, phase.total)) * 100)} %
            </span>
          </div>
          <Progress
            value={(phase.sent / Math.max(1, phase.total)) * 100}
            tone="info"
            label={t('uploadingAria')}
          />
          <p className="text-xs text-text-muted">
            {phase.cut
              ? t('cut')
              : phase.paused
                ? t('paused', { sent: formatBytes(phase.sent), total: formatBytes(phase.total) })
                : t('uploading', {
                    sent: formatBytes(phase.sent),
                    total: formatBytes(phase.total),
                  })}
          </p>
          <div className="flex flex-wrap gap-2">
            {phase.paused ? (
              <Button type="button" size="sm" onClick={up.resume}>
                <Icon name="play" size={13} />
                {t('resume')}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={up.pause}>
                {t('pause')}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => void up.cancel()}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={
            busy
              ? 'block cursor-wait rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-6 text-center opacity-70'
              : dragging
                ? 'block cursor-copy rounded-lg border-2 border-dashed border-brand-400 bg-brand-50 p-6 text-center'
                : 'block cursor-pointer rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-6 text-center transition-colors hover:border-brand-300 hover:bg-brand-50'
          }
        >
          <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-lg text-text-muted">
            <Icon name="video" size={24} />
          </div>
          <p className="text-sm font-semibold text-text">
            {phase.kind === 'reading'
              ? t('reading')
              : phase.kind === 'preparing'
                ? t('preparing')
                : shown && attached
                  ? t('dropReplace')
                  : t('dropTitle')}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {t('dropHelp', {
              size: formatBytes(quota.maxFileBytes),
              duration: formatDuration(quota.maxFileSeconds),
            })}
          </p>
          <QuotaLine quota={quota} />
        </label>
      )}
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="video/*,.mkv,.mts"
        disabled={busy}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void up.handleFile(file);
        }}
      />

      {up.problem ? (
        <div
          role="alert"
          className="rounded-md border border-danger-100 bg-danger-50 p-2 text-xs text-danger-700"
        >
          {problemText(up.problem)}
        </div>
      ) : null}
    </div>
  );
}

function QuotaLine({ quota }: { quota: VideoQuota }) {
  const lines = useQuotaLines(quota);
  return <p className="mt-2 text-xs text-text-subtle">{lines.stored}</p>;
}

function UploadedCard({
  asset,
  processing,
  unsaved,
  onReplace,
  onRemove,
}: {
  asset: VideoAsset;
  processing: boolean;
  unsaved: boolean;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('formadorCursos.videoUpload');
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface-2 p-3">
      <div className="relative grid h-16 w-28 shrink-0 place-items-center overflow-hidden rounded-md bg-black/80 text-white/70">
        {asset.thumbnailUrl && !processing ? (
          // La miniatura viene firmada de la CDN (caduca en una hora).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Icon name={processing ? 'clock' : 'video'} size={20} />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-semibold text-text">{asset.title}</p>
        <p className="text-xs text-text-muted">
          {processing
            ? t('processing')
            : t('ready', {
                duration: formatSeconds(asset.durationSeconds ?? 0),
                resolution: asset.maxResolution,
              })}
        </p>
        {unsaved ? <p className="text-xs font-medium text-brand">{t('saveHint')}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onReplace}>
          {t('replace')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          {t('remove')}
        </Button>
      </div>
    </div>
  );
}
