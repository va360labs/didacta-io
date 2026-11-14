'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { retentionApi } from './client';

/**
 * Entrada a «Miembros en riesgo» desde la lista de alumnos, con cuántas
 * personas hay ahora mismo (14 días sin entrar, la vista por defecto del
 * panel). Si el módulo está apagado en el aula, no se pinta.
 */
export function AtRiskCard() {
  const t = useTranslations('modRetention.tarjeta');
  const [count, setCount] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    retentionApi
      .atRisk({ days: 14 })
      .then((r) => setCount(r.counts.all))
      .catch(() => setCount(null));
  }, []);

  if (count === null) return null;

  return (
    <Link
      href="/admin/users/at-risk"
      data-testid="enlace-riesgo"
      className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4 hover:border-border-strong"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-warning-50 text-warning-700">
        <Icon name="alert" size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-text">{t('titulo')}</span>
        <span className="text-sm text-text-muted">
          {count === undefined
            ? t('cargando')
            : count === 0
              ? t('nadie')
              : t('personas', { n: count })}
        </span>
      </span>
      <Icon name="chevron-right" size={16} />
    </Link>
  );
}
