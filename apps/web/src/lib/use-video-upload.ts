'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiHttpError } from '@/lib/api-client';
import {
  preflight,
  readVideoDuration,
  startTusUpload,
  videoUploadApi,
  type UploadHandle,
  type VideoAsset,
  type VideoQuota,
} from '@/lib/video-upload';

/**
 * Lógica de «subir el vídeo de una lección», SIN pintar nada: la usan el
 * editor de lecciones del modo completo (`VideoUploadField`) y el del modo
 * sencillo (`SimpleVideoField`), cada uno con su maqueta. Los textos tampoco
 * viven aquí: el hook devuelve el motivo del error y cada pantalla lo cuenta.
 */

/**
 * ¿Puede esta academia subir vídeos?
 *
 *  - `on`: sí, con su espacio y sus límites.
 *  - `off`: la instalación no tiene subida de vídeo (la API da 404: sin
 *    `BUNNY_STREAM_API_KEY`) o quien edita no gestiona cursos (403). Solo vale
 *    el enlace.
 *  - `error`: no se ha podido preguntar (red, 5xx). NO es lo mismo que `off`:
 *    se ofrece reintentar en vez de esconder la subida.
 */
export type VideoQuotaState =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'error' }
  | { kind: 'on'; quota: VideoQuota };

export function useVideoQuota(): {
  state: VideoQuotaState;
  /** Vuelve a preguntar. Sin pasar por `loading` si ya había respuesta. */
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<VideoQuotaState>({ kind: 'loading' });
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const q = await videoUploadApi.quota();
      if (alive.current) setState(q ? { kind: 'on', quota: q } : { kind: 'off' });
    } catch {
      if (alive.current) setState((s) => (s.kind === 'on' ? s : { kind: 'error' }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  return { state, refresh };
}

export type UploadPhase =
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
    };

/** Por qué no se ha subido (o no se ha quedado) un vídeo. */
export type UploadProblem =
  | { kind: 'noDuration' }
  | { kind: 'notVideo' }
  | { kind: 'tooBig'; sizeBytes: number; limitBytes: number }
  | { kind: 'tooLong'; durationSeconds: number; limitSeconds: number }
  | { kind: 'noRoom'; durationSeconds: number; freeSeconds: number }
  | { kind: 'api'; error: ApiHttpError }
  | { kind: 'generic' }
  | {
      kind: 'failed';
      reason: 'tooLong' | 'quota' | 'uploadFailed' | 'abandoned' | 'encoding';
      limitSeconds: number;
    };

const POLL_MS = 5000;

function failedReason(asset: VideoAsset): Extract<UploadProblem, { kind: 'failed' }>['reason'] {
  switch (asset.failureReason) {
    case 'too_long':
      return 'tooLong';
    case 'quota':
      return 'quota';
    case 'upload_failed':
      return 'uploadFailed';
    case 'abandoned':
      return 'abandoned';
    default:
      return 'encoding';
  }
}

export interface UseVideoUploadOptions {
  /** Espacio y límites del aula (null mientras no se sabe o sin subida). */
  quota: VideoQuota | null;
  /** Para refrescar el espacio tras subir o borrar. */
  refreshQuota: () => Promise<void>;
  /**
   * La lección. En el modo sencillo una lección nueva aún no existe al abrir
   * el formulario: se crea al elegir el fichero con `ensureLessonId`.
   */
  lessonId: string | null;
  ensureLessonId?: (file: File) => Promise<string>;
  /** El enlace del formulario (aún sin guardar). */
  videoUrl: string;
  /** El enlace guardado en la lección. */
  savedVideoUrl: string;
  onVideoUrl: (url: string) => void;
  /** Al terminar de subir (antes de procesar): el editor puede guardarlo ya. */
  onUploaded?: (asset: VideoAsset, lessonId: string) => void | Promise<void>;
  /** Duración real (minutos) cuando el vídeo está listo. */
  onDuration?: (minutes: number) => void;
}

export function useVideoUpload(opts: UseVideoUploadOptions) {
  const { quota, lessonId } = opts;
  // La subida en curso (si la hay) y, aparte, el vídeo subido que enseña la
  // ficha: un error al intentar sustituirlo no hace desaparecer el que hay.
  const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
  const [current, setCurrent] = useState<VideoAsset | null>(null);
  const [problem, setProblem] = useState<UploadProblem | null>(null);
  // Buscando el vídeo subido que ya usa la lección (al abrirla).
  const [checking, setChecking] = useState(false);
  const handle = useRef<UploadHandle | null>(null);
  const mounted = useRef(true);
  // Los callbacks y el enlace, siempre los últimos (los usan temporizadores).
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void handle.current?.abort();
    };
  }, []);

  // ¿La lección ya usa un vídeo subido? Se enseña su estado. Solo al abrir la
  // lección (o cuando se sabe que hay subida): no al crearla aquí mismo.
  const quotaOn = quota !== null;
  const openedWith = useRef<string | null>(lessonId);
  useEffect(() => {
    const id = openedWith.current;
    if (!quotaOn || !id) return;
    let cancelled = false;
    setChecking(true);
    void (async () => {
      const assets = await videoUploadApi.listForLesson(id).catch(() => []);
      if (!cancelled) setChecking(false);
      const found = assets.find((a) => a.embedUrl === latest.current.savedVideoUrl);
      if (cancelled || !found) return;
      if (
        found.status === 'READY' ||
        found.status === 'PROCESSING' ||
        found.status === 'UPLOADING'
      ) {
        setCurrent((c) => c ?? found);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [quotaOn]);

  // Mientras se procesa, se pregunta cada 5 s (la API, a su vez, a Bunny).
  const processingId =
    current && (current.status === 'PROCESSING' || current.status === 'UPLOADING')
      ? current.id
      : null;
  useEffect(() => {
    if (!processingId) return;
    const timer = window.setInterval(() => {
      void videoUploadApi
        .get(processingId)
        .then((asset) => {
          if (!mounted.current) return;
          if (asset.status === 'READY') {
            setCurrent(asset);
            if (asset.durationSeconds) {
              latest.current.onDuration?.(Math.max(1, Math.round(asset.durationSeconds / 60)));
            }
            void latest.current.refreshQuota();
          } else if (asset.status === 'FAILED' || asset.status === 'DELETED') {
            setCurrent(null);
            setProblem({
              kind: 'failed',
              reason: failedReason(asset),
              limitSeconds: latest.current.quota?.maxFileSeconds ?? 7200,
            });
            if (latest.current.videoUrl === asset.embedUrl) latest.current.onVideoUrl('');
            void latest.current.refreshQuota();
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [processingId]);

  async function handleFile(file: File) {
    if (!quota) return;
    setProblem(null);
    setPhase({ kind: 'reading' });
    const duration = await readVideoDuration(file);
    if (duration === null) {
      setPhase({ kind: 'idle' });
      setProblem({ kind: 'noDuration' });
      return;
    }
    const check = preflight(file, duration, quota);
    if (check) {
      setPhase({ kind: 'idle' });
      if (check.kind === 'not_video') setProblem({ kind: 'notVideo' });
      else if (check.kind === 'too_big') {
        setProblem({ kind: 'tooBig', sizeBytes: file.size, limitBytes: check.limitBytes });
      } else if (check.kind === 'too_long') {
        setProblem({
          kind: 'tooLong',
          durationSeconds: duration,
          limitSeconds: check.limitSeconds,
        });
      } else {
        setProblem({
          kind: 'noRoom',
          durationSeconds: duration,
          freeSeconds: Math.max(0, quota.stored.limitSeconds - quota.stored.usedSeconds),
        });
      }
      return;
    }

    setPhase({ kind: 'preparing' });
    let targetLesson: string;
    let created: Awaited<ReturnType<typeof videoUploadApi.create>>;
    try {
      targetLesson = lessonId ?? (await latest.current.ensureLessonId!(file));
      created = await videoUploadApi.create({
        lessonId: targetLesson,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        durationSeconds: duration,
      });
    } catch (e) {
      if (!mounted.current) return;
      setPhase({ kind: 'idle' });
      setProblem(e instanceof ApiHttpError ? { kind: 'api', error: e } : { kind: 'generic' });
      void latest.current.refreshQuota();
      return;
    }
    const { asset, upload } = created;
    void latest.current.refreshQuota();
    if (!mounted.current) return;
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
        latest.current.onVideoUrl(asset.embedUrl);
        setCurrent({ ...asset, status: 'PROCESSING' });
        setPhase({ kind: 'idle' });
        void latest.current.onUploaded?.(asset, targetLesson);
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

  /** Cancela la subida en curso y borra lo que se había reservado. */
  async function cancel() {
    if (phase.kind !== 'uploading') return;
    const id = phase.asset.id;
    await handle.current?.abort();
    handle.current = null;
    setPhase({ kind: 'idle' });
    await videoUploadApi.remove(id).catch(() => undefined);
    void latest.current.refreshQuota();
  }

  const busy = phase.kind === 'reading' || phase.kind === 'preparing' || phase.kind === 'uploading';
  const attached = current !== null && opts.videoUrl === current.embedUrl;

  return {
    phase,
    /** El vídeo subido que usa (o va a usar) la lección. */
    current,
    /** ¿El enlace del formulario es el del vídeo subido? */
    attached,
    busy,
    checking,
    problem,
    handleFile,
    pause,
    resume,
    cancel,
  };
}
