'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type Ref } from 'react';
import { Icon } from '@/components/icon';
import { authStorage } from '@/lib/auth-storage';
import type { BunnyPlayUrlState } from '@/lib/use-bunny-play-url';
import { randomWatermarkPosition, watermarkLabel } from '@/lib/video';
import type { PlayUrlErrorKind } from '@/lib/video-protection';

/**
 * Cada cuánto salta la marca de agua a otra posición. Sin animación y con
 * saltos espaciados: una marca que cruza el vídeo cada pocos segundos distrae
 * de la clase.
 */
const WATERMARK_MOVE_MS = 120_000;

const ERROR_KEYS: Record<
  PlayUrlErrorKind,
  'forbidden' | 'rateLimited' | 'watchQuota' | 'loadError'
> = {
  forbidden: 'forbidden',
  rate_limited: 'rateLimited',
  watch_quota: 'watchQuota',
  unknown: 'loadError',
};

interface Props {
  /** Estado de la URL de reproducción (`useBunnyPlayUrl`). */
  play: BunnyPlayUrlState;
  /** Añade a la URL de reproducción los parámetros del reproductor. */
  buildSrc: (playUrl: string) => string;
  title: string;
  iframeRef?: Ref<HTMLIFrameElement>;
  /** Cambia para re-montar el iframe (salto a un capítulo). */
  iframeKey?: string | number;
}

/**
 * Reproductor de un vídeo de Bunny Stream: el iframe con la URL que da la API.
 *
 * Con la marca de agua activa en la academia, pinta encima la identidad del
 * alumno, que cambia de sitio cada 2 minutos. No impide grabar la pantalla (eso
 * solo lo hace el DRM con seguridad por hardware), pero cualquier copia grabada
 * lleva escrito quién la sacó. En ese modo la pantalla completa la hace ESTE
 * contenedor con un botón propio: si entrase el iframe solo, la marca, que vive
 * fuera de él, se quedaría fuera de la imagen. Donde la Fullscreen API no
 * existe sobre un div (iPhone), el botón no se pinta.
 *
 * Sin marca de agua el iframe es el de siempre, con su pantalla completa nativa.
 */
export function BunnyFrame({ play, buildSrc, title, iframeRef, iframeKey }: Props) {
  const t = useTranslations('playersContenido');
  const containerRef = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [position, setPosition] = useState({ topPct: 12, leftPct: 4 });
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const watermark = play.watermark;

  // Sesión y capacidades del navegador: solo en cliente (no existen en SSR).
  useEffect(() => {
    if (!watermark) return;
    const user = authStorage.getSession()?.user;
    if (user?.email && user.id) setLabel(watermarkLabel(user));
    setCanFullscreen(Boolean(document.fullscreenEnabled));
    setPosition(randomWatermarkPosition());

    const onFullscreenChange = () =>
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    const timer = window.setInterval(
      () => setPosition(randomWatermarkPosition()),
      WATERMARK_MOVE_MS,
    );
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.clearInterval(timer);
    };
  }, [watermark]);

  function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }

  const fullscreenLabel = isFullscreen ? t('video.exitFullscreen') : t('video.fullscreen');

  return (
    <div
      ref={containerRef}
      data-testid="bunny-frame"
      aria-busy={play.loading}
      className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
    >
      {play.url ? (
        <iframe
          key={iframeKey ?? 'init'}
          ref={iframeRef}
          src={buildSrc(play.url)}
          title={title}
          loading="lazy"
          className="h-full w-full"
          // Con marca de agua, sin `fullscreen` ni `picture-in-picture`: la
          // pantalla completa la hace el contenedor (con la marca dentro) y la
          // ventana flotante sacaría el vídeo sin marca.
          allow={
            watermark
              ? 'accelerometer; autoplay; encrypted-media; gyroscope'
              : 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen'
          }
          allowFullScreen={!watermark}
        />
      ) : play.error ? (
        <div
          role="alert"
          className="grid h-full w-full place-items-center px-6 text-center text-sm text-white/80"
        >
          {t(`video.${ERROR_KEYS[play.error.kind]}`)}
        </div>
      ) : null}

      {watermark && play.url && label ? (
        <span
          data-testid="video-watermark"
          aria-hidden
          className="pointer-events-none absolute z-10 select-none whitespace-nowrap font-medium text-white/25 [text-shadow:0_0_3px_rgba(0,0,0,0.6)]"
          // Crece con la pantalla: a pantalla completa, a 10-12 px se perdería
          // en la grabación o bastaría un desenfoque mínimo para borrarla.
          style={{
            top: `${position.topPct}%`,
            left: `${position.leftPct}%`,
            fontSize: 'clamp(10px, 1.1vw, 22px)',
          }}
        >
          {label}
        </span>
      ) : null}

      {watermark && play.url && canFullscreen ? (
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreenLabel}
          title={fullscreenLabel}
          className="absolute right-2 top-2 z-20 grid h-8 w-8 place-items-center rounded-md bg-black/45 text-white opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          <Icon name={isFullscreen ? 'minimize' : 'maximize'} size={16} />
        </button>
      ) : null}
    </div>
  );
}
