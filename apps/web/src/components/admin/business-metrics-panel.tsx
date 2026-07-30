'use client';

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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/stat-card';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminBusinessMetricsApi,
  type BusinessMetrics,
  type WeeklyPoint,
} from '@/lib/admin-business-metrics';

function euros(cents: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function formatWeek(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function BusinessMetricsPanel() {
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
          setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las métricas.');
        }
      });
    return () => {
      cancelled = true;
    };
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
      <p className="text-sm text-text-muted">
        Los KPIs del lunes: comunidad, ventas y salud de la membresía. Ventana de 30 días salvo que
        se indique otra cosa.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="NPS (30 días)"
          value={nps.score ?? '—'}
          hint={
            nps.responses > 0
              ? `${nps.responses} respuestas · ${nps.promoters} promotores · ${nps.detractors} detractores`
              : 'sin respuestas aún — se llena con las encuestas post-clase'
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
          label="Ventas (30 días)"
          value={euros(revenue.totalCents30d)}
          hint="cursos + membresía, cobrado"
          icon="chart"
          tone="info"
        />
        <StatCard
          label="Impagos ahora"
          value={arrears.total}
          hint={`${arrears.subscriptions} membresía · ${arrears.external} externos`}
          icon="bell"
          tone={arrears.total > 0 ? 'warn' : 'success'}
          href="/admin/impagos"
        />
        <StatCard
          label="Altas (30 días)"
          value={members.newMembers30d}
          hint={`${members.cancellations30d} bajas de membresía`}
          icon="users"
          tone="info"
        />
        <StatCard
          label="Activos 7 días"
          value={connections.active7d}
          hint={`${connections.active30d} en 30 días · ${connections.totalActive} miembros`}
          icon="users"
          tone="info"
        />
        <StatCard
          label="Tutor IA (30 días)"
          value={aiTutor.questions30d}
          hint={`preguntas · ${aiTutor.activeUsers30d} alumnos distintos · ${community.posts30d} posts en comunidad`}
          icon="sparkles"
          tone="neutral"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <WeeklyBars
          title="Ventas por semana"
          description="Cobros de cursos y membresía, últimas 12 semanas."
          points={revenue.weekly}
          format={euros}
        />
        <WeeklyBars
          title="Altas por semana"
          description="Miembros nuevos, últimas 12 semanas."
          points={members.weeklySignups}
          format={(v) => `${v} alta${v !== 1 ? 's' : ''}`}
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
                Semana del {formatWeek(p.weekStart)} · {format(p.value)}
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
        {empty ? (
          <p className="mt-2 text-xs text-text-subtle">Sin datos todavía en esta ventana.</p>
        ) : null}

        {/* Los mismos datos, accesibles como tabla. */}
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th>Semana</th>
              <th>Valor</th>
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
