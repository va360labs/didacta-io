'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Quién se quiere ir y por qué»: el resumen de la oferta al darse de baja para
 * la creadora (Alumnos en el modo sencillo; Membresía en el completo). Siempre
 * en «X de Y», nunca un porcentaje suelto: con 5 respuestas, un 60 % son 3
 * personas.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { formatDate } from '@/lib/i18n/format';
import { retentionApi, type RetentionConfig, type RetentionSummary } from '@/lib/retention';
import { cn } from '@/lib/utils';

const DAYS = 90;

export function RetentionSummaryCard({ settingsHref }: { settingsHref: string }) {
  const t = useTranslations('bajaRetencion.resumen');
  const tMotivo = useTranslations('bajaRetencion.motivos');
  const [summary, setSummary] = useState<RetentionSummary | null>(null);
  const [config, setConfig] = useState<RetentionConfig | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    void Promise.all([retentionApi.summary(DAYS), retentionApi.get().catch(() => null)])
      .then(([s, c]) => {
        setSummary(s);
        setConfig(c);
      })
      .catch(() => setError(true));
  }, []);

  const offersOff = config !== null && !config.pauseEnabled && !config.discountEnabled;

  return (
    <section
      className="rounded-2xl border border-border bg-surface p-4 sm:p-6"
      data-testid="retencion-resumen"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-text">{t('titulo')}</h2>
        <span className="text-sm text-text-subtle">{t('periodo', { dias: DAYS })}</span>
      </div>

      {error ? <p className="mt-3 text-sm text-danger-700">{t('error')}</p> : null}
      {!summary && !error ? <div className="skeleton mt-4 h-24 w-full" /> : null}

      {summary && summary.total === 0 ? (
        <p className="mt-3 max-w-[60ch] text-sm text-text-muted">{t('vacio')}</p>
      ) : null}

      {summary && summary.total > 0 ? (
        <div className="mt-4 space-y-5">
          <div>
            <p
              className="text-2xl font-extrabold tracking-tight text-text"
              data-testid="retencion-se-quedaron"
            >
              {t('seQuedaron', { n: summary.stayed, total: summary.total })}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              {t('desglose', {
                pausa: summary.paused,
                descuento: summary.discounted,
                baja: summary.canceled,
              })}
            </p>
            {summary.pausedNow + summary.pausesScheduled > 0 ? (
              <p className="mt-1 text-sm text-text-muted">
                {t('ahora', {
                  pausados: summary.pausedNow,
                  programadas: summary.pausesScheduled,
                })}
              </p>
            ) : null}
          </div>

          <div>
            <h3 className="text-[15px] font-bold text-text">{t('motivos')}</h3>
            <ul className="mt-2 space-y-2" data-testid="retencion-motivos">
              {summary.reasons.map((r) => (
                <li key={r.reason} className="text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-text">{tMotivo(r.reason as 'other')}</span>
                    <span className="shrink-0 text-text-muted">
                      {t('motivoCuenta', { n: r.count, total: summary.total })}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-bg-subtle" aria-hidden>
                    <div
                      className="h-2 rounded-full bg-brand-600"
                      style={{ width: `${Math.round((r.count / summary.total) * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-[15px] font-bold text-text">{t('ultimas')}</h3>
            <ul className="mt-2 divide-y divide-border" data-testid="retencion-ultimas">
              {summary.recent.slice(0, 8).map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-text">
                      {e.userName?.trim() || e.userEmail || t('sinNombre')}
                    </span>
                    <span className="block text-text-muted">
                      {tMotivo(e.reason as 'other')}
                      {e.reasonText ? ` · «${e.reasonText}»` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={cn(
                        'rounded-full px-2.5 py-0.5 text-xs font-bold',
                        e.outcome === 'CANCELED'
                          ? 'bg-bg-subtle text-text-subtle'
                          : 'bg-success-50 text-success-700',
                      )}
                    >
                      {e.outcome === 'PAUSED'
                        ? t('resultado.PAUSED', { n: e.pauseMonths ?? 1 })
                        : e.outcome === 'DISCOUNTED'
                          ? t('resultado.DISCOUNTED', { pct: e.discountPercent ?? 0 })
                          : t('resultado.CANCELED')}
                    </span>
                    <span className="text-xs text-text-subtle">
                      {formatDate(e.createdAt, { dateStyle: 'medium' })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {offersOff ? (
        <Link
          href={settingsHref}
          className="mt-4 flex items-center gap-3 rounded-xl bg-bg-subtle p-3 text-sm hover:bg-border-soft"
        >
          <Icon name="sparkles" size={18} />
          <span className="min-w-0 flex-1 text-text-muted">{t('sinOferta')}</span>
          <span className="font-semibold text-brand-600">{t('configurar')}</span>
        </Link>
      ) : null}
    </section>
  );
}
