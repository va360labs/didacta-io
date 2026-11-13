'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useRef, useState, type DragEvent } from 'react';
import { Icon } from '@/components/icon';
import { useQuotaLines } from '@/components/video-quota';
import { useUploadProblemText } from '@/components/video-upload-field';
import type { useVideoUpload, VideoQuotaState } from '@/lib/use-video-upload';
import { formatSeconds } from '@/lib/video';
import { formatBytes, formatDuration, type VideoAsset, type VideoQuota } from '@/lib/video-upload';
import { cn } from '@/lib/utils';

type Upload = ReturnType<typeof useVideoUpload>;

const SECONDARY_BTN =
  'inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-text hover:border-border-strong';

/**
 * El vídeo de una lección en el editor del MODO SENCILLO.
 *
 * Lo primero que se ve es «Sube tu vídeo» (arrastrar o elegir); el enlace de
 * YouTube/Vimeo queda como alternativa debajo. Subido, el vídeo se queda ya
 * guardado en la lección (lo guarda el formulario en `onUploaded`) y aquí se
 * enseña «preparándose» y luego la miniatura.
 *
 * Si la academia no puede subir vídeos, lo DICE y ofrece el enlace: nada de
 * una opción que no aparece o que falla en silencio. Si no se ha podido
 * preguntar, ofrece reintentar.
 */
export function SimpleVideoField({
  quotaState,
  onRetryQuota,
  upload,
  inputId,
  videoUrl,
  onLinkChange,
  onRemove,
}: {
  quotaState: VideoQuotaState;
  onRetryQuota: () => void;
  upload: Upload;
  inputId: string;
  videoUrl: string;
  onLinkChange: (url: string) => void;
  /** Quitar el vídeo subido de la lección. */
  onRemove: () => void;
}) {
  const t = useTranslations('modoSencillo.curso');
  const tv = useTranslations('formadorCursos.videoUpload');
  const problemText = useUploadProblemText();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { phase, current, attached, busy } = upload;

  const link = (label: string) => (
    <div>
      <label htmlFor="leccion-video" className="text-sm font-semibold text-text">
        {label}
      </label>
      <input
        id="leccion-video"
        value={videoUrl}
        onChange={(e) => onLinkChange(e.target.value)}
        placeholder="https://"
        className="mt-1.5 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
      />
    </div>
  );

  if (quotaState.kind === 'loading' || (quotaState.kind === 'on' && upload.checking)) {
    return <div className="skeleton h-44 w-full rounded-2xl" data-testid="video-cargando" />;
  }

  if (quotaState.kind === 'off' || quotaState.kind === 'error') {
    const off = quotaState.kind === 'off';
    return (
      <div className="grid gap-4">
        <section
          className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border-strong bg-surface p-5 sm:flex-row"
          data-testid={off ? 'video-sin-subida' : 'video-error-espacio'}
        >
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-bg-subtle text-text-muted"
            aria-hidden
          >
            <Icon name={off ? 'link' : 'alert'} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-text">
              {off ? t('subida.sinSubidaTitulo') : t('subida.errorEspacioTitulo')}
            </h3>
            <p className="mt-0.5 max-w-[60ch] text-sm text-text-muted">
              {off ? t('subida.sinSubidaTexto') : t('subida.errorEspacioTexto')}
            </p>
          </div>
          {off ? null : (
            <button type="button" onClick={onRetryQuota} className={SECONDARY_BTN}>
              {t('subida.reintentar')}
            </button>
          )}
        </section>
        {link(t('subida.enlaceSolo'))}
      </div>
    );
  }

  const quota = quotaState.quota;

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && !busy) void upload.handleFile(file);
  }

  return (
    <div className="grid gap-4" data-testid="video-upload">
      {phase.kind === 'uploading' ? (
        <section
          className="rounded-2xl border border-border bg-surface p-4"
          aria-live="polite"
          data-testid="video-subiendo"
        >
          <div className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"
              aria-hidden
            >
              <Icon name="video" size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-text">{phase.asset.title}</p>
              <p className="text-sm text-text-muted">
                {phase.cut
                  ? tv('cut')
                  : phase.paused
                    ? tv('paused', {
                        sent: formatBytes(phase.sent),
                        total: formatBytes(phase.total),
                      })
                    : tv('uploading', {
                        sent: formatBytes(phase.sent),
                        total: formatBytes(phase.total),
                      })}
              </p>
            </div>
            <span className="shrink-0 text-lg font-extrabold text-text tabular-nums">
              {Math.floor((phase.sent / Math.max(1, phase.total)) * 100)} %
            </span>
          </div>
          <Bar value={(phase.sent / Math.max(1, phase.total)) * 100} label={tv('uploadingAria')} />
          <div className="mt-3 flex flex-wrap gap-2">
            {phase.paused ? (
              <button
                type="button"
                onClick={upload.resume}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
              >
                <Icon name="play" size={14} />
                {tv('resume')}
              </button>
            ) : (
              <button type="button" onClick={upload.pause} className={SECONDARY_BTN}>
                {tv('pause')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void upload.cancel()}
              className="h-10 px-2 text-sm font-semibold text-text-muted hover:text-text"
            >
              {tv('cancel')}
            </button>
          </div>
        </section>
      ) : current && attached ? (
        <VideoCard
          asset={current}
          onReplace={() => inputRef.current?.click()}
          onRemove={onRemove}
        />
      ) : (
        <label
          htmlFor={inputId}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          data-testid="video-soltar"
          className={cn(
            'flex flex-col items-center rounded-2xl border-2 border-dashed px-5 py-8 text-center transition-colors',
            busy
              ? 'cursor-wait border-border-strong bg-bg-subtle'
              : dragging
                ? 'cursor-copy border-brand-600 bg-brand-50'
                : 'cursor-pointer border-border-strong bg-surface hover:border-brand-600 hover:bg-brand-50',
          )}
        >
          <span
            className="grid h-12 w-12 place-items-center rounded-xl bg-brand-50 text-brand-700"
            aria-hidden
          >
            <Icon name={busy ? 'clock' : 'video'} size={24} />
          </span>
          <span className="mt-3 text-base font-bold text-text">
            {phase.kind === 'reading'
              ? tv('reading')
              : phase.kind === 'preparing'
                ? tv('preparing')
                : dragging
                  ? t('subida.soltar')
                  : t('subida.subirTitulo')}
          </span>
          <span className="mt-1 max-w-[46ch] text-sm text-text-muted">
            {t('subida.subirAyuda', {
              size: formatBytes(quota.maxFileBytes),
              duration: formatDuration(quota.maxFileSeconds),
            })}
          </span>
          {busy ? null : (
            <span className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white">
              <Icon name="plus" size={17} />
              {t('subida.elegir')}
            </span>
          )}
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
        data-testid="video-fichero"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload.handleFile(file);
        }}
      />

      {upload.problem ? (
        <p
          role="alert"
          className="rounded-xl bg-danger-50 p-3 text-sm font-semibold text-danger-700"
        >
          {problemText(upload.problem)}
        </p>
      ) : null}

      {/* El enlace, como alternativa: no con un vídeo subido ni a mitad de subida. */}
      {(current && attached) || busy ? null : link(t('enlaceVideo'))}
    </div>
  );
}

function Bar({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="mt-3 h-2.5 overflow-hidden rounded-full bg-bg-subtle"
    >
      <div
        className="h-full rounded-full bg-brand-600 transition-[width] duration-300"
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

function QuotaLine({ quota }: { quota: VideoQuota }) {
  const lines = useQuotaLines(quota);
  return <span className="mt-4 text-[13px] text-text-subtle">{lines.stored}</span>;
}

function VideoCard({
  asset,
  onReplace,
  onRemove,
}: {
  asset: VideoAsset;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('modoSencillo.curso');
  const tv = useTranslations('formadorCursos.videoUpload');
  const ready = asset.status === 'READY';
  // Si la miniatura no carga (firma caducada, CDN caída) queda el icono.
  const [thumbFailed, setThumbFailed] = useState(false);
  return (
    <section
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 sm:flex-row sm:items-center"
      data-testid={ready ? 'video-listo' : 'video-procesando'}
    >
      <div className="relative grid aspect-video w-full shrink-0 place-items-center overflow-hidden rounded-xl bg-black/80 text-white/70 sm:w-48">
        {ready && asset.thumbnailUrl && !thumbFailed ? (
          <>
            {/* La miniatura viene firmada de la CDN (caduca en una hora). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setThumbFailed(true)}
            />
            <span className="absolute grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white">
              <Icon name="play" size={18} />
            </span>
          </>
        ) : (
          <Icon
            name={ready ? 'video' : 'clock'}
            size={26}
            className={ready ? '' : 'animate-pulse'}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold',
            ready ? 'bg-success-50 text-success-700' : 'bg-brand-50 text-brand-700',
          )}
        >
          <Icon name={ready ? 'check' : 'clock'} size={12} />
          {ready ? t('subida.estadoListo') : t('subida.estadoProcesando')}
        </span>
        <p className="mt-1.5 truncate font-semibold text-text">{asset.title}</p>
        <p className="mt-0.5 text-sm text-text-muted">
          {ready
            ? t('subida.listoDetalle', {
                duration: formatSeconds(asset.durationSeconds ?? 0),
                resolution: asset.maxResolution,
              })
            : tv('processing')}
        </p>
        <p className="mt-1 text-[13px] font-semibold text-success-700">
          {ready ? t('subida.guardadoListo') : t('subida.guardadoProcesando')}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onReplace} className={SECONDARY_BTN}>
            {tv('replace')}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="h-10 px-2 text-sm font-semibold text-text-muted hover:text-text"
          >
            {tv('remove')}
          </button>
        </div>
      </div>
    </section>
  );
}
