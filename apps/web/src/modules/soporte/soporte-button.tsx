'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { SoporteDialog } from './soporte-dialog';
import { useSoporteEnabled } from './use-soporte';

/** Mismo azul → verde que el avatar sin foto: el color de la marca en el menú. */
const DEGRADADO = 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)';

/**
 * Botón «Ayuda y sugerencias». Solo sale con mod.soporte encendido para el
 * aula y con sesión (sin token, `useSoporteEnabled` responde que no).
 *  - `card`: tarjeta destacada al final de la lista del menú lateral, dentro
 *    del scroll (menú expandido y cajón del móvil), para no robar alto a la lista.
 *  - `rail`: solo icono con un punto de color, en el rail plegado de escritorio.
 *  - `header`: el mismo icono en la cabecera blanca del modo sencillo, que no
 *    tiene menú lateral.
 */
export function SoporteButton({
  variant,
  onNavigate,
}: {
  variant: 'card' | 'rail' | 'header';
  /** Cierra el cajón del móvil antes de abrir la ventana. */
  onNavigate?: () => void;
}) {
  const t = useTranslations('modSoporte.boton');
  const enabled = useSoporteEnabled();
  const [open, setOpen] = useState(false);
  if (!enabled) return null;

  function abrir() {
    onNavigate?.();
    setOpen(true);
  }

  const etiqueta = t('etiqueta');

  return (
    <>
      {variant === 'header' ? (
        <button
          type="button"
          onClick={abrir}
          aria-label={etiqueta}
          title={etiqueta}
          data-testid="soporte-abrir"
          className="relative grid h-10 w-10 place-items-center rounded-xl text-text-muted hover:bg-bg-subtle hover:text-text"
        >
          <Icon name="help" size={20} />
          <span
            aria-hidden
            className="absolute right-2 top-2 h-2 w-2 rounded-full"
            style={{ background: DEGRADADO }}
          />
        </button>
      ) : variant === 'rail' ? (
        <button
          type="button"
          onClick={abrir}
          aria-label={etiqueta}
          title={etiqueta}
          data-testid="soporte-abrir"
          className="relative grid h-7 w-7 place-items-center rounded-lg text-white/50 transition-colors hover:bg-white/8 hover:text-white/90"
        >
          <Icon name="message" size={15} />
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 h-1.75 w-1.75 rounded-full"
            style={{ background: DEGRADADO }}
          />
        </button>
      ) : (
        <button
          type="button"
          onClick={abrir}
          data-testid="soporte-abrir"
          className="group mt-3 flex w-full items-center gap-3 rounded-xl bg-white/6 px-3 py-2.5 text-left ring-1 ring-white/10 transition-colors hover:bg-white/10"
        >
          <span
            aria-hidden
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white"
            style={{ background: DEGRADADO }}
          >
            <Icon name="message" size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight text-white">
              {etiqueta}
            </span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-white/60">
              {t('ayuda')}
            </span>
          </span>
        </button>
      )}
      <SoporteDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
