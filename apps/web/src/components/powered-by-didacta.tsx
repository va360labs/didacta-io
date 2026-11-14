'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useLocale, useTranslations } from 'next-intl';
import { poweredByHref } from '@/lib/academy-mark';
import { useTenantContext } from '@/lib/tenant-context';
import { cn } from '@/lib/utils';

interface Props {
  /**
   * Slug del aula para la campaña del enlace. Quien lo tiene en el servidor lo
   * pasa (así el HTML ya lleva el enlace completo); si no, se toma del aula
   * del dominio en cuanto se conoce.
   */
  slug?: string | null;
  /** `dark`: sobre un fondo oscuro (panel de marca del acceso). */
  tone?: 'light' | 'dark';
  className?: string;
}

/**
 * Pie «Powered by Didacta — Crea tu academia gratis»: el ÚNICO sitio del aula
 * donde sale Didacta (decisión de Valentín, 14-nov-2026). Discreto, en el
 * idioma en que se pinta el aula, al alta de didacta.io en ese idioma y con la
 * campaña del aula (`utm_campaign=<slug>`). Sin seguimiento extra: un enlace.
 *
 * Es el único componente de este pie: portada, venta, acceso, comunidad y 404
 * lo montan; quitarlo de un sitio es quitar ese `<PoweredByDidacta />`.
 */
export function PoweredByDidacta({ slug, tone = 'light', className }: Props) {
  const t = useTranslations('common.academyBrand');
  const locale = useLocale();
  const { tenant } = useTenantContext();
  const campaign = slug ?? tenant?.slug ?? null;
  return (
    <p className={cn('text-center text-[11px] leading-5', className)}>
      <a
        href={poweredByHref(locale, campaign)}
        target="_blank"
        rel="noopener"
        data-testid="powered-by-didacta"
        className={cn(
          'hover:underline',
          tone === 'dark'
            ? 'text-white/45 hover:text-white/75'
            : 'text-text-subtle hover:text-text-muted',
        )}
      >
        {t('poweredBy')}
      </a>
    </p>
  );
}
