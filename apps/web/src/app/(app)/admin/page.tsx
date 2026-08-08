'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel del tenant — el único dashboard del área de administración.
 *
 * Dos pestañas:
 *   - "Actividad": el pulso del aula (usuarios, cursos, matrículas, certificados).
 *   - "Negocio":   los KPIs del lunes, antes en `/admin/metricas` (que ahora
 *     redirige aquí). Eran dos dashboards compitiendo, cada uno con su entrada
 *     de menú y ninguna pista de cuál abrir.
 *
 * La tarjeta "Atajos" que había aquí se eliminó: duplicaba siete enlaces que ya
 * están en el sidebar y describía Branding como si viviera dentro de
 * Configuración, cuando tiene pantalla propia.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { StatCard } from '@/components/stat-card';
import { BusinessMetricsPanel } from '@/components/admin/business-metrics-panel';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { adminStatsApi, type AdminStats, type StatsRange } from '@/lib/admin-stats';

const RANGES: StatsRange[] = ['all', '30d', '7d'];

const TABS = ['actividad', 'negocio'] as const;
type TabKey = (typeof TABS)[number];

export default function AdminDashboardPage() {
  const t = useTranslations('adminFundae');
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as TabKey)
    : 'actividad';

  // La pestaña vive en la URL para que `/admin/metricas` pueda redirigir a
  // `/admin?tab=negocio` y el enlace sea compartible.
  function selectTab(next: string): void {
    router.replace(next === 'actividad' ? '/admin' : `/admin?tab=${next}`);
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('dashboard.title')}</h1>
        <p className="mt-1 text-text-muted">{t('dashboard.description')}</p>
      </header>

      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList>
          <TabsTrigger value="actividad">{t('dashboard.tabActivity')}</TabsTrigger>
          <TabsTrigger value="negocio">{t('dashboard.tabBusiness')}</TabsTrigger>
        </TabsList>

        <TabsContent value="actividad" className="mt-5">
          <ActivityTab />
        </TabsContent>
        <TabsContent value="negocio" className="mt-5">
          <BusinessMetricsPanel />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function ActivityTab(): ReactNode {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<StatsRange>('all');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminStatsApi
      .get(range)
      .then((res) => {
        if (!cancelled) {
          setStats(res);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(apiErrorMessage(e, tErrors));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-muted">
          {t.rich('dashboard.rangeNote', {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>

        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={
                range === r
                  ? 'rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-text-on-brand'
                  : 'rounded-md px-3 py-1.5 text-xs font-medium text-text-muted hover:text-text'
              }
            >
              {t(`statsRange.${r}`)}
            </button>
          ))}
        </div>
      </div>

      <MemberOnboardingCard />

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {stats === null && loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : stats !== null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            label={t('dashboard.statActiveUsers')}
            value={stats.activeUsers}
            hint={t('dashboard.statActiveUsersHint')}
            icon="users"
            tone="info"
            href="/admin/usuarios"
          />
          <StatCard
            label={t('dashboard.statCourses')}
            value={stats.coursesPublished}
            hint={t('dashboard.statCoursesHint')}
            icon="book"
            tone="info"
            href="/formador/cursos"
          />
          <StatCard
            label={t('dashboard.statEnrollments')}
            value={stats.totalEnrollments}
            hint={
              range === 'all'
                ? t('dashboard.hintHistoric')
                : t('dashboard.hintNewIn', { rango: rangeLabel(range, t) })
            }
            icon="trending"
            tone="success"
          />
          <StatCard
            label={t('dashboard.statCertificates')}
            value={stats.certificatesIssued}
            hint={
              range === 'all'
                ? t('dashboard.hintHistoric')
                : t('dashboard.hintIssuedIn', { rango: rangeLabel(range, t) })
            }
            icon="award"
            tone="success"
          />
          <StatCard
            label={t('dashboard.statCompletionRate')}
            value={`${stats.completionRate}%`}
            hint={t('dashboard.statCompletionRateHint')}
            icon="check"
            tone="success"
          />
        </div>
      ) : null}
    </div>
  );
}

function rangeLabel(r: StatsRange, t: TranslatorLike): string {
  return r === '7d' ? t('dashboard.rangeLast7') : t('dashboard.rangeLast30');
}

/**
 * Tarjeta con la URL pública de onboarding de miembros (`/inscripcion-miembros`).
 * La URL se arma con el origin actual → funciona en cualquier dominio del tenant
 * sin hardcodear. El admin la comparte con los miembros actuales para que se
 * den de alta (gate Telegram + aprobación manual).
 */
function MemberOnboardingCard(): ReactNode {
  const t = useTranslations('adminFundae');
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setUrl(window.location.origin + '/inscripcion-miembros');
  }, []);
  const copy = (): void => {
    if (!url || !navigator.clipboard) return;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="font-display text-lg font-semibold">{t('dashboard.onboardingTitle')}</h2>
        <p className="mt-1 text-sm text-text-muted">{t('dashboard.onboardingDescription')}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <code className="min-w-60 flex-1 break-all rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
            {url || '…'}
          </code>
          <button
            type="button"
            onClick={copy}
            disabled={!url}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-text-on-brand transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {copied ? t('dashboard.copied') : t('dashboard.copyLink')}
          </button>
          <a
            href={url || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text"
          >
            {t('dashboard.open')}
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
