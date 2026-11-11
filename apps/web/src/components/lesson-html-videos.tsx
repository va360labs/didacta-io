'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { memo, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { BunnyFrame } from '@/components/bunny-frame';
import {
  BUNNY_SLOT_ATTR,
  extractBunnyEmbeds,
  type BunnyHtmlEmbed,
} from '@/lib/lesson-bunny-embeds';
import { useBunnyPlayUrl } from '@/lib/use-bunny-play-url';
import { withOriginalBunnyParams } from '@/lib/video';

/**
 * El HTML de la lección, tal cual. MEMOIZADO a propósito: mientras el string no
 * cambie React no vuelve a tocar este nodo, así que ni los `<iframe>` que lleve
 * el HTML ni los reproductores montados en sus huecos se destruyen cuando el
 * resto de la página se re-renderiza (cada reporte de progreso lo hace).
 */
const RawLessonHtml = memo(function RawLessonHtml({
  html,
  hostRef,
}: {
  html: string;
  hostRef: Ref<HTMLDivElement>;
}) {
  return <div ref={hostRef} className="lesson-prose" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Reproductor de un vídeo de Bunny que venía incrustado a mano en el HTML. */
function LessonBunnySlot({ embed }: { embed: BunnyHtmlEmbed }) {
  const t = useTranslations('playersContenido');
  const play = useBunnyPlayUrl(embed.ref);
  return (
    <BunnyFrame
      play={play}
      title={embed.title || t('video.embeddedTitle')}
      // Conserva los parámetros que eligió quien escribió la lección.
      buildSrc={(playUrl) => withOriginalBunnyParams(playUrl, embed.src)}
    />
  );
}

/**
 * Contenido HTML de una lección (ya saneado). Los `<iframe>` de Bunny Stream
 * que lleve incrustados a mano se sustituyen por el mismo reproductor que usa
 * una lección de vídeo: pide su URL a la API —firmada si la academia protege
 * sus vídeos— y pinta la marca de agua si toca. Con la URL permanente que trae
 * el HTML, esos vídeos dejarían de cargar al activar el token en Bunny.
 *
 * Un HTML sin vídeos de Bunny se pinta exactamente igual que antes.
 */
export const LessonHtmlWithVideos = memo(function LessonHtmlWithVideos({ html }: { html: string }) {
  const prepared = useMemo(() => extractBunnyEmbeds(html), [html]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<Array<{ el: Element; embed: BunnyHtmlEmbed }>>([]);

  // Tras pintar el HTML, localiza los huecos para montar en ellos los
  // reproductores. Se repite solo si cambia el HTML.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || prepared.embeds.length === 0) {
      setSlots([]);
      return;
    }
    const found: Array<{ el: Element; embed: BunnyHtmlEmbed }> = [];
    for (const embed of prepared.embeds) {
      const el = host.querySelector(`[${BUNNY_SLOT_ATTR}="${embed.slot}"]`);
      if (el) found.push({ el, embed });
    }
    setSlots(found);
  }, [prepared]);

  return (
    <>
      <RawLessonHtml html={prepared.html} hostRef={hostRef} />
      {slots.map(({ el, embed }) =>
        createPortal(<LessonBunnySlot embed={embed} />, el, String(embed.slot)),
      )}
    </>
  );
});
