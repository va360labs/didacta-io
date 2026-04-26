'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { formadorStatsApi, type FormadorStats } from '@/lib/formador-stats';

export default function FormadorDashboardPage() {
  const [stats, setStats] = useState<FormadorStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setStats(await formadorStatsApi.get());
        setError(null);
      } catch (e) {
        setError(
          e instanceof ApiHttpError
            ? e.message
            : 'No pudimos cargar las stats. Probá refrescar la página.',
        );
      }
    })();
  }, []);

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700"
      >
        {error}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-12 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-8">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Panel del formador</h1>
        <p className="mt-1 text-text-muted">
          Vista general de cursos, alumnos y correcciones pendientes en tu organización.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Cursos publicados"
          value={stats.coursesPublished}
          hint={`${stats.coursesDraft} en borrador`}
          href="/formador/cursos"
        />
        <StatCard
          label="Matriculaciones activas"
          value={stats.totalActiveEnrollments}
          hint={`${stats.totalCompletedEnrollments} completadas en total`}
        />
        <StatCard
          label="Progreso promedio"
          value={`${stats.averageProgressPercent}%`}
          hint="del alumnado activo y finalizado"
        />
        <StatCard
          label="Correcciones pendientes"
          value={stats.pendingGradings}
          hint={
            stats.pendingGradings > 0
              ? 'respuestas abiertas por revisar'
              : 'estás al día — sin pendientes'
          }
          href="/formador/correcciones"
          highlight={stats.pendingGradings > 0}
        />
      </div>

      <Card>
        <CardContent className="p-6">
          <h2 className="font-display text-lg font-semibold mb-4">Atajos</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <ShortcutLink
              href="/formador/cursos"
              label="Mis cursos"
              hint="Crear, editar, publicar y archivar."
            />
            <ShortcutLink
              href="/formador/correcciones"
              label="Correcciones pendientes"
              hint="Revisar respuestas abiertas de quizzes."
              highlight={stats.pendingGradings > 0}
            />
            <ShortcutLink
              href="/formador/cursos/nuevo"
              label="Crear curso nuevo"
              hint="Empezá un curso desde cero."
            />
            <ShortcutLink
              href="/cursos"
              label="Ver el catálogo público"
              hint="Verlo como lo ven los alumnos."
            />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function StatCard({
  label,
  value,
  hint,
  href,
  highlight,
}: {
  label: string;
  value: number | string;
  hint: string;
  href?: string;
  highlight?: boolean;
}) {
  const inner = (
    <Card
      interactive={Boolean(href)}
      className={
        highlight ? 'border-warning-200 bg-warning-50/40 transition-colors' : 'transition-colors'
      }
    >
      <CardContent className="p-5">
        <p className="label-uppercase text-text-muted">{label}</p>
        <p className="font-display mt-1 text-4xl font-extrabold tabular-nums text-text">{value}</p>
        <p className="mt-2 text-xs text-text-subtle leading-relaxed">{hint}</p>
      </CardContent>
    </Card>
  );
  return href ? (
    <Link
      href={href as never}
      className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      {inner}
    </Link>
  ) : (
    inner
  );
}

function ShortcutLink({
  href,
  label,
  hint,
  highlight,
}: {
  href: string;
  label: string;
  hint: string;
  highlight?: boolean;
}): ReactNode {
  return (
    <Link
      href={href as never}
      className={
        highlight
          ? 'flex items-start gap-3 rounded-lg border border-warning-200 bg-warning-50/40 p-4 transition-colors hover:bg-warning-50'
          : 'flex items-start gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-2'
      }
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
