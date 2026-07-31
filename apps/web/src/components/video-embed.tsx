'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRef, useState } from 'react';
import {
  bunnyEmbedUrl,
  formatSeconds,
  parseBunny,
  parseResources,
  parseYouTubeId,
  parseYouTubeStartSeconds,
  youTubeEmbedUrl,
} from '@/lib/video';
import { useBunnyWatch, type WatchReport } from '@/lib/use-bunny-watch';

interface Props {
  url: string;
  title: string;
  /**
   * Texto libre de recursos/capítulos. Las líneas `MM:SS - Texto` se vuelven
   * capítulos clicables que hacen seek en el vídeo; el resto, viñetas.
   */
  resources?: string;
  /**
   * Segundo en el que arrancar (reanudar donde lo dejó el alumno). Aplica a
   * `<video>` directo (seek en `loadedmetadata`) y a Bunny Stream (parámetro
   * `t` del embed). No aplica a YouTube.
   */
  resumeAt?: number;
  /** Oculta la lista de recursos aunque `resources` traiga contenido. */
  hideResources?: boolean;
  /**
   * Reporte de visionado REAL. Hoy solo se mide en Bunny Stream (vía Player.js);
   * en otros proveedores no se invoca. Si no se pasa, no se mide nada.
   */
  onWatch?: (report: WatchReport) => void;
  /** Habilita/pausa la medición (p.ej. se apaga al completar la lección). */
  watchEnabled?: boolean;
}

/**
 * Player de vídeo unificado: detecta YouTube, Bunny Stream o fichero directo
 * (mp4/webm/HLS) y lo embebe. Soporta deep-links a un punto del vídeo desde
 * los capítulos `MM:SS - Texto` de los recursos: en `<video>` hace seek en
 * sitio; en iframes (YouTube/Bunny) re-monta el embed arrancando en ese
 * segundo con autoplay.
 */
export function VideoEmbed({
  url,
  title,
  resources,
  resumeAt = 0,
  hideResources,
  onWatch,
  watchEnabled = true,
}: Props) {
  // `seek` cambia al pulsar un capítulo; `nonce` fuerza el re-mount del iframe.
  const [seek, setSeek] = useState<{ seconds: number; nonce: number } | null>(null);
  const nonceRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bunnyIframeRef = useRef<HTMLIFrameElement>(null);

  const bunny = parseBunny(url);
  const ytId = bunny ? null : parseYouTubeId(url);

  // Medición de visionado real (solo Bunny por ahora). El hook no hace nada si
  // no hay callback, está deshabilitado o no es un iframe de Bunny.
  useBunnyWatch({
    iframeRef: bunnyIframeRef,
    onReport: onWatch ?? (() => {}),
    enabled: Boolean(bunny && onWatch && watchEnabled),
    remountKey: seek?.nonce ?? 0,
  });

  function handleSeek(seconds: number) {
    const v = videoRef.current;
    if (v) {
      // <video> directo: seek en sitio, sin recargar.
      v.currentTime = seconds;
      void v.play().catch(() => {});
      v.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // iframe (YouTube/Bunny): re-montar el embed arrancando en ese segundo.
    nonceRef.current += 1;
    setSeek({ seconds, nonce: nonceRef.current });
  }

  let player: React.ReactNode;
  if (!url) {
    player = (
      <div className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-6 py-12 text-center text-sm text-text-muted">
        Falta el vídeo. Pídele al formador que lo cargue.
      </div>
    );
  } else if (bunny) {
    player = (
      <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
        <iframe
          key={seek?.nonce ?? 'init'}
          ref={bunnyIframeRef}
          src={bunnyEmbedUrl(bunny, {
            // Al saltar a un capítulo manda `seek`; si no, arranca en la posición
            // de reanudación guardada (si la hay). El player de Bunny queda
            // pausado (autoplay solo en el salto de capítulo), así que si la
            // posición llega tarde solo re-sitúa el vídeo, sin interrumpir.
            startSeconds: seek?.seconds ?? (resumeAt > 0 ? resumeAt : undefined),
            autoplay: seek != null,
          })}
          title={title}
          loading="lazy"
          className="h-full w-full"
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
    );
  } else if (ytId) {
    const start = seek?.seconds ?? parseYouTubeStartSeconds(url);
    const base = youTubeEmbedUrl(ytId, start ? { startSeconds: start } : {});
    const src = seek ? `${base}&autoplay=1` : base;
    player = (
      <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
        <iframe
          key={seek?.nonce ?? 'init'}
          src={src}
          title={title}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  } else {
    player = (
      <video
        ref={videoRef}
        controls
        preload="metadata"
        className="w-full rounded-lg border border-border bg-black"
        // eslint-disable-next-line jsx-a11y/media-has-caption
        src={url}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (resumeAt > 0 && resumeAt < v.duration) v.currentTime = resumeAt;
        }}
      />
    );
  }

  const lines = !hideResources && resources ? parseResources(resources) : [];
  const chapters = lines.flatMap((l) => (l.kind === 'chapter' ? [l] : []));
  const bullets = lines.flatMap((l) => (l.kind === 'text' ? [l] : []));

  return (
    <div>
      {player}

      {(chapters.length > 0 || bullets.length > 0) && (
        // Espacio generoso entre el vídeo y los recursos (pedido del cliente).
        <div className="mt-8 space-y-6">
          {chapters.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold text-text">Capítulos</h3>
              <ul className="space-y-0.5">
                {chapters.map((c, i) => (
                  <li key={`${c.seconds}-${i}`}>
                    <button
                      type="button"
                      onClick={() => handleSeek(c.seconds)}
                      className="group flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2"
                    >
                      <span className="shrink-0 tabular-nums font-semibold text-brand-700 group-hover:underline">
                        {formatSeconds(c.seconds)}
                      </span>
                      <span className="text-text">{c.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {bullets.length > 0 && (
            <div className="space-y-1.5">
              {chapters.length > 0 && <h3 className="text-sm font-semibold text-text">Recursos</h3>}
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-text">
                {bullets.map((b, i) => (
                  <li key={i}>
                    {b.segments.map((seg, j) =>
                      seg.type === 'link' ? (
                        <a
                          key={j}
                          href={seg.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-700 underline underline-offset-2 hover:text-brand-800 break-all"
                        >
                          {seg.label}
                        </a>
                      ) : (
                        <span key={j}>{seg.value}</span>
                      ),
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
