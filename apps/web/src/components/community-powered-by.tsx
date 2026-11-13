'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useLocale, useTranslations } from 'next-intl';

/**
 * Pie «Powered by Didacta» de la barra lateral de la comunidad, como el
 * «Powered by skool». Decisión de negocio aprobada por Valentín (13-nov-2026):
 * discreto, para todos los miembros, a didacta.io en el idioma del aula.
 *
 * Vive SOLO aquí y se monta en un único sitio (`community-sidebar.tsx`):
 * quitarlo es borrar esa línea.
 */
export function CommunityPoweredBy() {
  const t = useTranslations('comunidadComponentes');
  const locale = useLocale();
  const lang = locale.toLowerCase().startsWith('es') ? 'es' : 'en';
  return (
    <p className="px-1 text-center text-[11px] text-text-subtle">
      <a
        href={`https://didacta.io/${lang}`}
        target="_blank"
        rel="noopener"
        className="hover:text-text-muted hover:underline"
        data-testid="powered-by-didacta"
      >
        {t('sidebar.poweredBy')}
      </a>
    </p>
  );
}
