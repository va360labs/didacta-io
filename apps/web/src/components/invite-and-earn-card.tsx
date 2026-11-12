'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { formatNumber } from '@/lib/i18n/format';
import { referralsApi } from '@/lib/referrals';
import { fetchTenantContext } from '@/lib/tenant-context';
import { cn } from '@/lib/utils';

/** Porcentaje legible a partir de puntos básicos (1250 → «12,5»). */
export function percentFromBps(bps: number): string {
  return formatNumber(bps / 100, { maximumFractionDigits: 2 });
}

/**
 * «Invita y gana» en contexto (modo sencillo): el enlace personal del alumno,
 * un botón para copiarlo y lo que gana, en llano. Reutiliza el programa de
 * referidos (`/modules/referrals/me` y `/me/stats`); si el aula no lo tiene
 * activo, o el alumno no puede tener enlace, no pinta nada.
 *
 * Solo con la membresía a la venta: el módulo paga comisión por las cuotas de
 * la membresía (no por un curso suelto) y el enlace personal lleva a `/unete`.
 * Sin membresía activa, el enlace caería en una página apagada y no daría nada.
 */
export function InviteAndEarnCard({
  variant = 'aside',
  context = 'community',
  className,
}: {
  variant?: 'aside' | 'inline';
  /** Dónde aparece: cambia la frase de entrada (comunidad, lección, curso). */
  context?: 'community' | 'lesson' | 'course' | 'progress';
  className?: string;
}) {
  const t = useTranslations('modoSencillo');
  const [percent, setPercent] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      referralsApi
        .myStats()
        .then(async (s) => {
          if (cancelled || !s.programActive) return;
          const ctx = await fetchTenantContext().catch(() => null);
          if (cancelled || !ctx?.tenant?.membershipPageActive) return;
          const link = await referralsApi.me();
          if (cancelled) return;
          setPercent(percentFromBps(s.commissionBps));
          setUrl(link.url);
        })
        .catch(() => undefined);
    } catch {
      // Sin sesión: sin tarjeta.
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (!percent || !url) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el enlace sigue visible para copiarlo a mano */
    }
  }

  return (
    <section
      data-testid="invite-and-earn"
      className={cn(
        'rounded-2xl border border-border bg-surface p-4',
        variant === 'inline' && 'border-brand-100 bg-brand-50/60',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 text-white"
          aria-hidden
        >
          <Icon name="sparkles" size={18} />
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-text">
            {context === 'community' || context === 'progress'
              ? t('referidos.titulo')
              : t('referidos.tituloContexto')}
          </h3>
          <p className="mt-0.5 text-sm text-text-muted">{t('referidos.gana', { percent })}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-text-muted">
          {url.replace(/^https?:\/\//, '')}
        </span>
        <button
          type="button"
          onClick={copy}
          className="h-9 shrink-0 rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {copied ? t('referidos.copiado') : t('referidos.copiar')}
        </button>
      </div>
      <Link
        href="/referidos"
        className="mt-3 inline-block text-sm font-semibold text-brand-600 hover:underline"
      >
        {t('referidos.verGanado')}
      </Link>
    </section>
  );
}
