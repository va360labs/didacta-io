'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
        setError(e instanceof ApiHttpError ? e.message : 'No se pudieron cargar las stats');
      }
    })();
  }, []);

  if (error)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!stats) return <p className="text-sm text-neutral-500">Cargando…</p>;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Panel del formador</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Vista general de cursos, alumnos y correcciones pendientes en tu tenant.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Cursos publicados"
          value={stats.coursesPublished}
          hint={`+ ${stats.coursesDraft} en draft`}
          href="/formador/cursos"
        />
        <StatCard
          label="Matriculaciones activas"
          value={stats.totalActiveEnrollments}
          hint={`${stats.totalCompletedEnrollments} completadas`}
        />
        <StatCard
          label="Progreso promedio"
          value={`${stats.averageProgressPercent}%`}
          hint="del alumnado activo + completado"
        />
        <StatCard
          label="Correcciones pendientes"
          value={stats.pendingGradings}
          hint={
            stats.pendingGradings > 0 ? 'tenés respuestas abiertas por revisar' : 'estás al día ✓'
          }
          href="/formador/correcciones"
          highlight={stats.pendingGradings > 0}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Atajos</CardTitle>
          <CardDescription>Las acciones más usadas del panel.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          <Link
            href="/formador/cursos"
            className="rounded-md border border-neutral-200 p-3 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
          >
            → Mis cursos
          </Link>
          <Link
            href="/formador/correcciones"
            className="rounded-md border border-neutral-200 p-3 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
          >
            → Correcciones pendientes
          </Link>
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
      className={
        highlight ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950' : ''
      }
    >
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-neutral-500">{hint}</p>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
