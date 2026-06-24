'use client';

import { useEffect, useRef } from 'react';
import { advanceWatch, breakWatchContinuity, initWatchState, type WatchState } from '@/lib/video';
import {
  asTimeUpdate,
  buildAddEventListener,
  parsePlayerMessage,
  type PlayerEventName,
} from '@/lib/player-js-protocol';

export interface WatchReport {
  /** Segundos efectivamente reproducidos desde el reporte anterior. */
  watchedSecondsDelta: number;
  /** Posición actual (segundos) para reanudar el vídeo. */
  positionSeconds: number;
  /** Posición máxima alcanzada (segundos). */
  maxPositionSeconds: number;
  /** Duración total del vídeo (segundos); 0 si aún no se conoce. */
  durationSeconds: number;
  /** True si el reporte se dispara por el fin del vídeo. */
  ended: boolean;
}

interface Options {
  /** Iframe de Bunny ya montado. */
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Callback de reporte: se invoca periódicamente y en pausa/fin. */
  onReport: (report: WatchReport) => void;
  /** Si false, el hook no se engancha (p.ej. lección ya completada). */
  enabled: boolean;
  /** Segundos de visionado real entre reportes periódicos. Default 20. */
  reportEverySeconds?: number;
  /**
   * Cambia cuando el iframe se re-monta (salto a un capítulo): fuerza
   * re-enganchar al nuevo nodo.
   */
  remountKey?: number;
}

const SUBSCRIBED_EVENTS: PlayerEventName[] = ['timeupdate', 'pause', 'ended'];

/**
 * Mide el tiempo de visionado REAL de un vídeo de Bunny Stream vía el protocolo
 * Player.js (postMessage), implementado inline en `player-js-protocol`. Acumula
 * solo los segundos reproducidos —descartando pausas (no llegan `timeupdate`) y
 * saltos/seeks— y reporta deltas periódicamente y en pausa/fin/desmontaje.
 */
export function useBunnyWatch({
  iframeRef,
  onReport,
  enabled,
  reportEverySeconds = 20,
  remountKey = 0,
}: Options): void {
  // El callback en un ref: así no re-enganchamos al cambiar su identidad.
  const onReportRef = useRef(onReport);
  onReportRef.current = onReport;

  useEffect(() => {
    if (!enabled) return;
    const iframe = iframeRef.current;
    if (!iframe?.src) return;

    let origin: string;
    try {
      origin = new URL(iframe.src).origin;
    } catch {
      return;
    }

    let state: WatchState = initWatchState();
    let durationSeconds = 0;
    let reportedWatched = 0;
    let subscribed = false;

    const post = (msg: object) => {
      iframe.contentWindow?.postMessage(JSON.stringify(msg), origin);
    };

    const flush = (ended: boolean) => {
      const delta = state.watchedSeconds - reportedWatched;
      // Reportamos si hubo visionado nuevo, o si es el fin (para fijar posición).
      if (delta <= 0 && !ended) return;
      reportedWatched = state.watchedSeconds;
      onReportRef.current({
        watchedSecondsDelta: delta,
        positionSeconds: state.lastSeconds ?? state.maxPositionSeconds,
        maxPositionSeconds: state.maxPositionSeconds,
        durationSeconds,
        ended,
      });
    };

    const subscribe = () => {
      if (subscribed) return;
      subscribed = true;
      for (const ev of SUBSCRIBED_EVENTS) post(buildAddEventListener(ev));
    };

    const onMessage = (e: MessageEvent) => {
      // Vinculamos los mensajes a NUESTRO iframe (no a otros embeds del mismo
      // dominio que pudiera haber en la página) por la ventana emisora.
      if (e.source !== iframe.contentWindow) return;
      if (e.origin !== origin) return;
      const parsed = parsePlayerMessage(e.data);
      if (!parsed) return;

      switch (parsed.event) {
        case 'ready':
          subscribe();
          break;
        case 'timeupdate': {
          const t = asTimeUpdate(parsed.value);
          if (!t) break;
          if (t.duration > 0) durationSeconds = t.duration;
          state = advanceWatch(state, t.seconds);
          if (state.watchedSeconds - reportedWatched >= reportEverySeconds) flush(false);
          break;
        }
        case 'pause':
          flush(false);
          // Tras la pausa puede venir un seek: cortamos la continuidad para no
          // contar el salto como visionado.
          state = breakWatchContinuity(state);
          break;
        case 'ended':
          flush(true);
          break;
      }
    };

    // Provoca el handshake: si Bunny ya estaba listo, re-emite `ready` (spec);
    // si aún no, recibiremos su `ready` proactivo. Lo reintentamos en `load`
    // para cubrir el caso de que el iframe no estuviera listo para recibir.
    const requestReady = () => post(buildAddEventListener('ready'));

    window.addEventListener('message', onMessage);
    iframe.addEventListener('load', requestReady);
    requestReady();

    return () => {
      flush(false);
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', requestReady);
    };
  }, [enabled, reportEverySeconds, remountKey, iframeRef]);
}
