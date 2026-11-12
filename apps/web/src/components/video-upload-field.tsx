'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useQuotaLines } from '@/components/video-quota';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  formatBytes,
  formatDuration,
  preflight,
  readVideoDuration,
  startTusUpload,
  videoUploadApi,
  type UploadHandle,
  type VideoAsset,
  type VideoQuota,
} from '@/lib/video-upload';

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'preparing' }
  | {
      kind: 'uploading';
      asset: VideoAsset;
      sent: number;
      total: number;
      paused: boolean;
      cut: boolean;
    }
  | { kind: 'processing'; asset: VideoAsset }
  | { kind: 'ready'; asset: VideoAsset };

const POLL_MS = 5000;

/**
 * «Subir vídeo» en el editor de una lección de vídeo: arrastrar o elegir el
 * fichero, progreso con pausa y reanudar, y el estado del procesado. Al
 * terminar de subir, rellena el enlace de la lección con el del vídeo subido.
 *
 * Si la academia no tiene subida de vídeo (sin Didacta Cloud) no pinta nada y
 * el editor se queda solo con el campo del enlace, como siempre.
 */
export function VideoUploadField({
  lessonId,
  videoUrl,
  savedVideoUrl,
  onVideoUrl,
}: {
  lessonId: string;
  /** El enlace del formulario (aún sin guardar). */
  videoUrl: string;
  /** El enlace guardado en la lección. */
  savedVideoUrl: string;
  onVideoUrl: (url: string) => void;
}) {
  const t = useTranslations('formadorCursos.videoUpload');
  const tErrors = useTranslations('errors');
  const [quota, setQuota] = useState<VideoQuota | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const handle = useRef<UploadHandle | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      const q = await videoUploadApi.quota().catch(() => null);
      if (cancelled || !q) return;
      setQuota(q);
      // ¿La lección ya usa un vídeo subido? Se enseña su estado.
      const assets = await videoUploadApi.listForLesson(lessonId).catch(() => []);
      const current = assets.find((a) => a.embedUrl === savedVideoUrl);
      if (cancelled || !current) return;
      if (current.status === 'READY') setPhase({ kind: 'ready', asset: current });
      else if (current.status === 'PROCESSING' || current.status === 'UPLOADING') {
        setPhase({ kind: 'processing', asset: current });
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
      void handle.current?.abort();
    };
    // Solo al abrir la lección.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);

  // Mientras se procesa, se pregunta cada 5 s.
  const processingId = phase.kind === 'processing' ? phase.asset.id : null;
  useEffect(() => {
    if (!processingId) return;
    const timer = window.setInterval(() => {
      void videoUploadApi
        .get(processingId)
        .then((asset) => {
          if (!mounted.current) return;
          if (asset.status === 'READY') {
            setPhase({ kind: 'ready', asset });
            void refreshQuota();
          } else if (asset.status === 'FAILED' || asset.status === 'DELETED') {
            setPhase({ kind: 'idle' });
            setError(failureMessage(asset));
            if (videoUrl === asset.embedUrl) onVideoUrl('');
            void refreshQuota();
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processingId]);

  async function refreshQuota() {
    const q = await videoUploadApi.quota().catch(() => null);
    if (q && mounted.current) setQuota(q);
  }

  function failureMessage(asset: VideoAsset): string {
    switch (asset.failureReason) {
      case 'too_long':
        return t('failed.tooLong', { limit: formatDuration(quota?.maxFileSeconds ?? 7200) });
      case 'quota':
        return t('failed.quota');
      case 'upload_failed':
        return t('failed.uploadFailed');
      case 'abandoned':
        return t('failed.abandoned');
      default:
        return t('failed.encoding');
    }
  }

  async function handleFile(file: File) {
    if (!quota) return;
    setError(null);
    setPhase({ kind: 'reading' });
    const duration = await readVideoDuration(file);
    if (duration === null) {
      setPhase({ kind: 'idle' });
      setError(t('errors.noDuration'));
      return;
    }
    const problem = preflight(file, duration, quota);
    if (problem) {
      setPhase({ kind: 'idle' });
      if (problem.kind === 'not_video') setError(t('errors.notVideo'));
      else if (problem.kind === 'too_big') {
        setError(
          t('errors.tooBig', {
            size: formatBytes(file.size),
            limit: formatBytes(problem.limitBytes),
          }),
        );
      } else if (problem.kind === 'too_long') {
        setError(
          t('errors.tooLong', {
            duration: formatDuration(duration),
            limit: formatDuration(problem.limitSeconds),
          }),
        );
      } else {
        setError(
          t('errors.noRoom', {
            duration: formatDuration(duration),
            free: formatDuration(Math.max(0, quota.stored.limitSeconds - quota.stored.usedSeconds)),
          }),
        );
      }
      return;
    }

    setPhase({ kind: 'preparing' });
    let created: Awaited<ReturnType<typeof videoUploadApi.create>>;
    try {
      created = await videoUploadApi.create({
        lessonId,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        durationSeconds: duration,
      });
    } catch (e) {
      setPhase({ kind: 'idle' });
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errors.generic'));
      void refreshQuota();
      return;
    }
    const { asset, upload } = created;
    setPhase({ kind: 'uploading', asset, sent: 0, total: file.size, paused: false, cut: false });
    handle.current = await startTusUpload({
      file,
      assetId: asset.id,
      ticket: upload,
      onProgress: (sent, total) => {
        if (!mounted.current) return;
        setPhase((p) =>
          p.kind === 'uploading' && p.asset.id === asset.id ? { ...p, sent, total, cut: false } : p,
        );
      },
      onSuccess: () => {
        handle.current = null;
        if (!mounted.current) return;
        onVideoUrl(asset.embedUrl);
        setPhase({ kind: 'processing', asset: { ...asset, status: 'PROCESSING' } });
      },
      onError: () => {
        if (!mounted.current) return;
        setPhase((p) => (p.kind === 'uploading' ? { ...p, paused: true, cut: true } : p));
      },
    });
  }

  function pause() {
    handle.current?.pause();
    setPhase((p) => (p.kind === 'uploading' ? { ...p, paused: true } : p));
  }

  function resume() {
    handle.current?.resume();
    setPhase((p) => (p.kind === 'uploading' ? { ...p, paused: false, cut: false } : p));
  }

  async function cancel() {
    if (phase.kind !== 'uploading') return;
    const id = phase.asset.id;
    await handle.current?.abort();
    handle.current = null;
    setPhase({ kind: 'idle' });
    await videoUploadApi.remove(id).catch(() => undefined);
    void refreshQuota();
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  if (!quota) return null;

  const busy = phase.kind === 'reading' || phase.kind === 'preparing' || phase.kind === 'uploading';
  const inputId = `video-upload-${lessonId}`;
  const shown = phase.kind === 'ready' || phase.kind === 'processing' ? phase.asset : null;
  const attached = shown !== null && videoUrl === shown.embedUrl;

  return (
    <div className="space-y-3" data-testid="video-upload">
      {shown && attached ? (
        <UploadedCard
          asset={shown}
          processing={phase.kind === 'processing'}
          unsaved={savedVideoUrl !== shown.embedUrl}
          onReplace={() => inputRef.current?.click()}
          onRemove={() => {
            onVideoUrl('');
            setPhase({ kind: 'idle' });
          }}
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
              <Button type="button" size="sm" onClick={resume}>
                <Icon name="play" size={13} />
                {t('resume')}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={pause}>
                {t('pause')}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => void cancel()}>
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
          if (file) void handleFile(file);
        }}
      />

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-danger-100 bg-danger-50 p-2 text-xs text-danger-700"
        >
          {error}
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
                duration: formatDuration(asset.durationSeconds ?? 0),
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
