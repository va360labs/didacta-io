'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { StatCard } from '@/components/stat-card';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import { adminStatsApi, type AdminStats, type StatsRange } from '@/lib/admin-stats';

const RANGE_LABELS: Array<{ key: StatsRange; label: string }> = [
  { key: 'all', label: 'Histórico' },
  { key: '30d', label: 'Últimos 30 días' },
  { key: '7d', label: 'Últimos 7 días' },
];

export default function AdminDashboardPage() {
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
          setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las stats.');
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
    <section className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Panel del tenant</h1>
          <p className="mt-1 text-text-muted">
            Métricas clave de actividad de tu organización. Las <strong>matriculaciones</strong> y{' '}
            <strong>certificados</strong> respetan el rango; usuarios activos y cursos publicados
            son siempre el snapshot actual.
          </p>
        </div>

        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
          {RANGE_LABELS.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={
                range === r.key
                  ? 'rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-text-on-brand'
                  : 'rounded-md px-3 py-1.5 text-xs font-medium text-text-muted hover:text-text'
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

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
            label="Usuarios activos"
            value={stats.activeUsers}
            hint="con status ACTIVE"
            icon="users"
            tone="info"
            href="/admin/usuarios"
          />
          <StatCard
            label="Cursos publicados"
            value={stats.coursesPublished}
            hint="snapshot actual del catálogo"
            icon="book"
            tone="info"
            href="/formador/cursos"
          />
          <StatCard
            label="Matriculaciones"
            value={stats.totalEnrollments}
            hint={range === 'all' ? 'histórico total' : `nuevas en ${rangeLabel(range)}`}
            icon="trending"
            tone="success"
          />
          <StatCard
            label="Certificados emitidos"
            value={stats.certificatesIssued}
            hint={range === 'all' ? 'histórico total' : `emitidos en ${rangeLabel(range)}`}
            icon="award"
            tone="success"
          />
          <StatCard
            label="Tasa de finalización"
            value={`${stats.completionRate}%`}
            hint="completed / total del rango"
            icon="check"
            tone="success"
          />
        </div>
      ) : null}

      <Card>
        <CardContent className="p-6">
          <h2 className="font-display text-lg font-semibold mb-4">Atajos</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <ShortcutLink
              href="/admin/usuarios"
              label="Usuarios y formadores"
              hint="Invitar, suspender, asignar roles."
            />
            <ShortcutLink
              href="/admin/configuracion"
              label="Configuración del tenant"
              hint="SMTP, módulos, branding y plantillas."
            />
            <ShortcutLink
              href="/admin/branding"
              label="Branding"
              hint="Color de marca, fuentes, logo."
            />
            <ShortcutLink
              href="/admin/auditoria"
              label="Auditoría"
              hint="Cadena de hashes verificable."
            />
            <ShortcutLink
              href="/admin/zoom/webhook-events"
              label="Webhooks Zoom"
              hint="Trazabilidad de eventos recibidos para QA."
            />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function rangeLabel(r: StatsRange): string {
  return r === '7d' ? 'los últimos 7 días' : 'los últimos 30 días';
}

function ShortcutLink({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}): ReactNode {
  return (
    <Link
      href={href as never}
      className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-2"
    >
      <span className="text-brand-500 text-lg" aria-hidden="true">
        →
      </span>
      <div className="flex-1">
        <p className="font-semibold text-text">{label}</p>
        <p className="mt-0.5 text-xs text-text-muted">{hint}</p>
      </div>
    </Link>
  );
}
