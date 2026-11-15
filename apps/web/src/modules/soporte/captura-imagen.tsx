'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { soporteApi } from './client';

/**
 * La captura de un ticket. La ruta pide Bearer: se baja como blob, se pinta
 * con un object URL y se libera al desmontar. Enlaza a la imagen a tamaño real.
 */
export function CapturaImagen({ ticketId, className }: { ticketId: string; className?: string }) {
  const t = useTranslations('modSoporte.captura');
  const [url, setUrl] = useState<string | null>(null);
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setFallo(false);
    soporteApi
      .captura(ticketId)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (alive) setFallo(true);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ticketId]);

  if (fallo) return <p className="text-xs text-text-muted">{t('error')}</p>;
  if (!url) return <div className="skeleton h-20 w-32 rounded-md" aria-hidden="true" />;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-block"
      data-testid="soporte-captura"
      title={t('abrir')}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={t('alt')}
        className={
          className ?? 'h-20 w-auto max-w-[12rem] rounded-md border border-border object-cover'
        }
      />
    </a>
  );
}
