'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { percentFromBps } from '@/components/invite-and-earn-card';
import { ApiHttpError } from '@/lib/api-client';
import { formatCents, formatDate, formatNumber } from '@/lib/i18n/format';
import {
  referralsApi,
  type MemberReferralStats,
  type ReferralCommissionStatus,
} from '@/lib/referrals';
import { useTenantDisplayName } from '@/lib/tenant-context';
import { cn } from '@/lib/utils';

export interface ReferralFigures {
  /** Confirmado: aprobado (por cobrar) + ya pagado. */
  earnedCents: number;
  /** Aún en plazo de devolución: se puede anular. */
  pendingCents: number;
  /** Comisiones de este mes (sin las anuladas). */
  thisMonthCents: number;
  /** Personas que entraron con el enlace. */
  people: number;
  currency: string;
}

/**
 * Cifras de la página con datos REALES del programa: no hay «pagando ahora»
 * ni lista de invitados en el módulo, así que no se inventan.
 */
export function referralFigures(
  stats: MemberReferralStats,
  now: Date = new Date(),
): ReferralFigures {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonthCents = stats.commissions
    .filter((c) => c.status !== 'REVOKED')
    .filter((c) => {
      const d = new Date(c.createdAt);
      return d.getUTCFullYear() === y && d.getUTCMonth() === m;
    })
    .reduce((sum, c) => sum + c.amountCents, 0);
  return {
    earnedCents: stats.totals.approvedCents + stats.totals.paidCents,
    pendingCents: stats.totals.pendingCents,
    thisMonthCents,
    people: stats.referrals,
    currency: (stats.commissions[0]?.currency ?? 'eur').toUpperCase(),
  };
}

const STATUS_TONE: Record<ReferralCommissionStatus, string> = {
  PENDING: 'bg-warning-50 text-warning-700',
  APPROVED: 'bg-brand-50 text-brand-700',
  PAID: 'bg-success-50 text-success-700',
  REVOKED: 'bg-danger-50 text-danger-700',
};

/**
 * «Invita y gana» del alumno en MODO SENCILLO (sobre `mod.referrals`): el % que
 * puso el creador, el enlace personal con Copiar y compartir, lo ganado y cómo
 * funciona con la configuración real del programa.
 */
export function SimpleReferrals() {
  const t = useTranslations('modoSencilloAprender.referidos');
  const academy = useTenantDisplayName();
  const [stats, setStats] = useState<MemberReferralStats | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    let cancelled = false;
    referralsApi
      .myStats()
      .then((s) => {
        if (cancelled) return;
        setStats(s);
        if (!s.programActive) return;
        referralsApi
          .me()
          .then((l) => !cancelled && setLink(l.url))
          .catch((e) => {
            if (cancelled) return;
            setLinkError(
              e instanceof ApiHttpError && e.code === 'REFERRALS_MEMBERSHIP_REQUIRED'
                ? t('membresiaRequerida')
                : t('errorEnlace'),
            );
          });
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (error) return <p className="text-text-muted">{t('errorCarga')}</p>;
  if (!stats) return <div className="skeleton h-80 w-full max-w-3xl" />;

  const percent = percentFromBps(stats.commissionBps);
  const fig = referralFigures(stats);
  const money = (c: number) => formatCents(c, fig.currency);
  const shareText = t('mensajeCompartir', { academia: academy });

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el enlace sigue a la vista */
    }
  }

  const ganas =
    stats.scope === 'FIRST_PAYMENT'
      ? t('pasos.ganaPrimerPago', { percent })
      : stats.recurringMonths
        ? t('pasos.ganaMeses', { percent, months: stats.recurringMonths })
        : t('pasos.ganaCadaPago', { percent });

  return (
    <div className="mx-auto max-w-[1080px]" data-testid="referidos-sencillo">
      <nav
        aria-label={t('migasAria')}
        className="flex items-center gap-1.5 text-sm text-text-subtle"
      >
        <Link href="/cuenta" className="hover:text-text">
          {t('migaPerfil')}
        </Link>
        <Icon name="chevron-right" size={14} />
        <span className="font-semibold text-text-muted">{t('titulo')}</span>
      </nav>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="grid min-w-0 gap-5">
          <section className="rounded-2xl border border-border bg-surface p-5 lg:p-7">
            <h1 className="max-w-[24ch] text-[26px] leading-tight font-extrabold tracking-tight text-text lg:text-[32px]">
              {stats.programActive ? t('heroTitulo', { percent }) : t('inactivoTitulo')}
            </h1>
            <p className="mt-2 max-w-[60ch] text-text-muted">
              {stats.programActive
                ? stats.memberCopy?.trim() || t('heroTexto', { academia: academy })
                : t('inactivoTexto')}
            </p>

            {stats.programActive ? (
              linkError ? (
                <p className="mt-5 rounded-xl bg-bg-subtle p-4 text-sm text-text-muted">
                  {linkError}
                </p>
              ) : (
                <>
                  <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                    <div className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border border-dashed border-brand-200 bg-brand-50/60 px-3 text-[15px] text-text">
                      <Icon name="link" size={16} />
                      <span className="truncate" data-testid="referidos-enlace">
                        {link ? link.replace(/^https?:\/\//, '') : '…'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={copy}
                      disabled={!link}
                      className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 text-[15px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      <Icon name="link" size={16} />
                      {copied ? t('copiado') : t('copiar')}
                    </button>
                  </div>
                  {link ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <a
                        href={`https://wa.me/?text=${encodeURIComponent(`${shareText} ${link}`)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-3.5 text-sm font-semibold text-text hover:border-border-strong"
                      >
                        <Icon name="messages" size={16} />
                        WhatsApp
                      </a>
                      <a
                        href={`mailto:?subject=${encodeURIComponent(academy)}&body=${encodeURIComponent(`${shareText}\n\n${link}`)}`}
                        className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-3.5 text-sm font-semibold text-text hover:border-border-strong"
                      >
                        <Icon name="mail" size={16} />
                        {t('correo')}
                      </a>
                      {canShare ? (
                        <button
                          type="button"
                          onClick={() =>
                            void navigator
                              .share({ title: academy, text: shareText, url: link })
                              .catch(() => undefined)
                          }
                          className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-3.5 text-sm font-semibold text-text hover:border-border-strong"
                        >
                          <Icon name="arrow-right" size={16} />
                          {t('mas')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )
            ) : null}
          </section>

          <section
            className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-surface sm:grid-cols-3"
            aria-label={t('cifrasAria')}
          >
            <div className="col-span-2 border-b border-border p-4 sm:col-span-1 sm:border-r sm:border-b-0">
              <div className="text-[26px] font-extrabold tracking-tight text-brand-700 tabular-nums">
                {money(fig.earnedCents)}
              </div>
              <div className="text-sm text-text-muted">{t('ganadoTotal')}</div>
              {fig.pendingCents > 0 ? (
                <div className="mt-1 text-xs text-text-subtle">
                  {t('pendiente', { amount: money(fig.pendingCents) })}
                </div>
              ) : null}
            </div>
            <div className="border-r border-border p-4">
              <div className="text-[26px] font-extrabold tracking-tight text-text tabular-nums">
                {formatNumber(fig.people)}
              </div>
              <div className="text-sm text-text-muted">{t('personas')}</div>
            </div>
            <div className="p-4">
              <div className="text-[26px] font-extrabold tracking-tight text-text tabular-nums">
                {money(fig.thisMonthCents)}
              </div>
              <div className="text-sm text-text-muted">{t('esteMes')}</div>
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-surface">
            <div className="px-4 pt-4 pb-2 lg:px-5">
              <h2 className="text-base font-bold text-text">{t('listaTitulo')}</h2>
              <p className="text-sm text-text-muted">{t('listaTexto')}</p>
            </div>
            {stats.commissions.length === 0 ? (
              <p className="px-4 pb-5 text-sm text-text-subtle lg:px-5">{t('listaVacia')}</p>
            ) : (
              <ul>
                {stats.commissions.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 border-t border-border-soft px-4 py-3 lg:px-5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-text">
                        {formatDate(c.createdAt, { dateStyle: 'medium' })}
                      </div>
                      <div className="text-xs text-text-subtle">
                        {t('sobre', {
                          amount: formatCents(c.baseAmountCents, c.currency.toUpperCase()),
                        })}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'rounded-full px-2.5 py-0.5 text-xs font-bold',
                        STATUS_TONE[c.status],
                      )}
                    >
                      {t(`estado.${c.status}`)}
                    </span>
                    <span className="w-20 text-right font-bold text-text tabular-nums">
                      {formatCents(c.amountCents, c.currency.toUpperCase())}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="grid min-w-0 gap-5">
          <section className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-bold text-text">{t('comoTitulo')}</h2>
            <ol className="mt-3 grid gap-3.5">
              {[
                [t('pasos.compartes'), t('pasos.compartesTexto')],
                [t('pasos.entra'), t('pasos.entraTexto', { days: stats.attributionWindowDays })],
                [t('pasos.ganas'), ganas],
              ].map(([titulo, texto], i) => (
                <li key={titulo} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-50 text-sm font-bold text-brand-700 tabular-nums">
                    {i + 1}
                  </span>
                  <span>
                    <span className="block text-sm font-bold text-text">{titulo}</span>
                    <span className="block text-sm text-text-muted">{texto}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 flex gap-2 rounded-xl bg-bg-subtle p-3 text-sm text-text-muted">
              <Icon name="help" size={16} />
              <span>
                {stats.minPayoutCents > 0
                  ? t('cobroMinimo', { academia: academy, min: money(stats.minPayoutCents) })
                  : t('cobro', { academia: academy })}
              </span>
            </p>
          </section>

          <section className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-bold text-text">{t('dudasTitulo')}</h2>
            <div className="mt-2">
              {[
                [t('dudas.cuando'), t('dudas.cuandoTexto', { days: stats.attributionWindowDays })],
                [t('dudas.devolucion'), t('dudas.devolucionTexto')],
                [
                  t('dudas.limite'),
                  stats.scope === 'FIRST_PAYMENT'
                    ? t('dudas.limitePrimerPago')
                    : stats.recurringMonths
                      ? t('dudas.limiteMeses', { months: stats.recurringMonths })
                      : t('dudas.limiteSin'),
                ],
              ].map(([q, a]) => (
                <details key={q} className="group border-t border-border-soft first:border-t-0">
                  <summary className="flex h-12 cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold text-text">
                    {q}
                    <span className="transition-transform group-open:rotate-180">
                      <Icon name="chevron-down" size={15} />
                    </span>
                  </summary>
                  <p className="pb-3 text-sm text-text-muted">{a}</p>
                </details>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
