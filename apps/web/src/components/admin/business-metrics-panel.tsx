'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * KPIs del negocio — la pestaña "Negocio" del panel de administración.
 *
 * Vivía en su propia página `/admin/metricas`, compitiendo con `/admin` por ser
 * "el dashboard": dos entradas de menú y ninguna pista de cuál abrir. Ahora es
 * una pestaña del panel y `/admin/metricas` redirige aquí.
 *
 * Todo sale de la BD local (webhooks ya materializados); nada de APIs externas
 * en caliente.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/stat-card';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCents, formatDate } from '@/lib/i18n/format';
import {
  adminBusinessMetricsApi,
  type BusinessMetrics,
  type WeeklyPoint,
} from '@/lib/admin-business-metrics';

function formatWeek(iso: string): string {
  // timeZone UTC deliberada: `weekStart` es una fecha-calendario (lunes) sin
  // hora; formatearla en la TZ del navegador podría desplazarla un día.
  return formatDate(`${iso}T00:00:00Z`, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function BusinessMetricsPanel() {
  const t = useTranslations('adminMonetizacion.metrics');
  const tErrors = useTranslations('errors');
  const [metrics, setMetrics] = useState<BusinessMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    adminBusinessMetricsApi
      .get()
      .then((m) => {
        if (!cancelled) setMetrics(m);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(apiErrorMessage(e, tErrors));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
      >
        {error}
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-28 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  const { nps, revenue, arrears, members, connections, aiTutor, community } = metrics;

  return (
    <div className="space-y-5">
      <p className="text-sm text-text-muted">{t('intro')}</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={t('npsLabel')}
          value={nps.score ?? '—'}
          hint={
            nps.responses > 0
              ? t('npsHint', {
                  responses: nps.responses,
                  promoters: nps.promoters,
                  detractors: nps.detractors,
                })
              : t('npsEmpty')
          }
          icon="chart"
          tone={
            nps.score === null
              ? 'neutral'
              : nps.score >= 30
                ? 'success'
                : nps.score < 0
                  ? 'warn'
                  : 'info'
          }
        />
        <StatCard
          label={t('revenueLabel')}
          value={formatCents(revenue.totalCents30d)}
          hint={t('revenueHint')}
          icon="chart"
          tone="info"
        />
        <StatCard
          label={t('arrearsLabel')}
          value={arrears.total}
          hint={t('arrearsHint', {
            subscriptions: arrears.subscriptions,
            external: arrears.external,
          })}
          icon="bell"
          tone={arrears.total > 0 ? 'warn' : 'success'}
          href="/admin/impagos"
        />
        <StatCard
          label={t('signupsLabel')}
          value={members.newMembers30d}
          hint={t('signupsHint', { cancellations: members.cancellations30d })}
          icon="users"
          tone="info"
        />
        <StatCard
          label={t('activeLabel')}
          value={connections.active7d}
          hint={t('activeHint', {
            active30d: connections.active30d,
            total: connections.totalActive,
          })}
          icon="users"
          tone="info"
        />
        <StatCard
          label={t('aiTutorLabel')}
          value={aiTutor.questions30d}
          hint={t('aiTutorHint', {
            students: aiTutor.activeUsers30d,
            posts: community.posts30d,
          })}
          icon="sparkles"
          tone="neutral"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <WeeklyBars
          title={t('weeklyRevenueTitle')}
          description={t('weeklyRevenueDescription')}
          points={revenue.weekly}
          format={(v) => formatCents(v)}
        />
        <WeeklyBars
          title={t('weeklySignupsTitle')}
          description={t('weeklySignupsDescription')}
          points={members.weeklySignups}
          format={(v) => t('signupsCount', { count: v })}
        />
      </div>
    </div>
  );
}

/**
 * Barras semanales de UNA serie (sin leyenda: el título la nombra). Marcas
 * finas con remate redondeado, hueco de 2px, tooltip por barra al hover y una
 * tabla accesible con los mismos datos.
 */
function WeeklyBars({
  title,
  description,
  points,
  format,
}: {
  title: string;
  description: string;
  points: WeeklyPoint[];
  format: (v: number) => string;
}) {
  const t = useTranslations('adminMonetizacion.metrics');
  const max = Math.max(...points.map((p) => p.value), 1);
  const empty = points.every((p) => p.value === 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex h-40 items-end gap-0.5" role="img" aria-label={title}>
          {points.map((p) => (
            <div key={p.weekStart} className="group relative flex h-full flex-1 items-end">
              <div
                className="w-full rounded-t-[4px] bg-(--didacta-trust)"
                style={{
                  height: p.value === 0 ? '2px' : `${Math.max((p.value / max) * 100, 3)}%`,
                  opacity: p.value === 0 ? 0.15 : undefined,
                }}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-[#0D1B2A] px-2 py-1 text-[11px] font-medium text-white shadow-lg group-hover:block">
                {t('weekTooltip', { week: formatWeek(p.weekStart), value: format(p.value) })}
              </div>
              {/* Zona de hover más grande que la marca. */}
              <div className="absolute inset-0" />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-text-subtle">
          <span>{formatWeek(points[0]!.weekStart)}</span>
          <span>{formatWeek(points.at(-1)!.weekStart)}</span>
        </div>
        {empty ? <p className="mt-2 text-xs text-text-subtle">{t('emptyWindow')}</p> : null}

        {/* Los mismos datos, accesibles como tabla. */}
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th>{t('weekHeader')}</th>
              <th>{t('valueHeader')}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.weekStart}>
                <td>{formatWeek(p.weekStart)}</td>
                <td>{format(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
