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
import { loadMyReferralLinks, type ReferralProductLink } from '@/lib/referral-links';
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
 * Vale para todo lo que vende el aula (membresía y cursos sueltos): se pinta si
 * hay CUALQUIER cosa a la venta. Si hay más de un producto, debajo del enlace
 * general se puede copiar el de cada uno. Sin nada a la venta no se pinta: el
 * enlace caería en una página vacía y no daría nada.
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
  const [products, setProducts] = useState<ReferralProductLink[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [needsTerms, setNeedsTerms] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      loadMyReferralLinks()
        .then((r) => {
          if (cancelled || !r) return;
          setPercent(percentFromBps(r.commissionBps));
          if (r.needsTerms) {
            setNeedsTerms(true);
            return;
          }
          setUrl(r.links.general);
          setProducts(r.links.products);
        })
        .catch(() => undefined);
    } catch {
      // Sin sesión: sin tarjeta.
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (percent && needsTerms) {
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
            <h3 className="text-[15px] font-bold text-text">{t('referidos.titulo')}</h3>
            <p className="mt-0.5 text-sm text-text-muted">{t('referidos.gana', { percent })}</p>
          </div>
        </div>
        <Link
          href="/referidos"
          className="mt-3 inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {t('referidos.activarEnlace')}
        </Link>
      </section>
    );
  }
  if (!percent || !url) return null;

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(link);
      setTimeout(() => setCopied(null), 2000);
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
          onClick={() => void copy(url)}
          className="h-9 shrink-0 rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {copied === url ? t('referidos.copiado') : t('referidos.copiar')}
        </button>
      </div>
      {products.length > 0 ? (
        <details className="group mt-2" data-testid="invite-and-earn-productos">
          <summary className="cursor-pointer list-none text-sm font-semibold text-text-muted hover:text-text">
            {t('referidos.porProducto')}
          </summary>
          <ul className="mt-2 grid gap-1.5">
            {products.map((p) => (
              <li key={p.url} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-text">
                  {p.title ?? t('referidos.membresia')}
                </span>
                <button
                  type="button"
                  onClick={() => void copy(p.url)}
                  className="h-8 shrink-0 rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold text-text hover:border-border-strong"
                >
                  {copied === p.url ? t('referidos.copiado') : t('referidos.copiar')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <Link
        href="/referidos"
        className="mt-3 inline-block text-sm font-semibold text-brand-600 hover:underline"
      >
        {t('referidos.verGanado')}
      </Link>
    </section>
  );
}
