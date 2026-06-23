'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import {
  enrollmentsToCsv,
  learningApi,
  type CourseEnrollmentRow,
  type EnrollmentStatus,
} from '@/lib/learning';

type SortKey = 'name' | 'progress' | 'enrolled' | 'lastLogin';
type SortDir = 'asc' | 'desc';

const STATUS_LABEL: Record<EnrollmentStatus, string> = {
  ACTIVE: 'Activo',
  COMPLETED: 'Completado',
  CANCELLED: 'Cancelado',
};

const STATUS_VARIANT: Record<EnrollmentStatus, 'success' | 'warning' | 'muted'> = {
  ACTIVE: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'muted',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function AlumnosPage() {
  const params = useParams<{ id: string }>();
  const courseId = params?.id;
  const [rows, setRows] = useState<CourseEnrollmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | EnrollmentStatus>('');
  const [sortKey, setSortKey] = useState<SortKey>('progress');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  async function reload() {
    if (!courseId) return;
    try {
      setError(null);
      const data = await learningApi.listEnrollmentsByCourse(courseId, {
        status: statusFilter || undefined,
      });
      setRows(data);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar el listado.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, statusFilter]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const copy = [...rows];
    copy.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      switch (sortKey) {
        case 'name':
          return (
            (a.userName ?? a.userEmail ?? '').localeCompare(b.userName ?? b.userEmail ?? '') * dir
          );
        case 'progress':
          return (a.progressPercent - b.progressPercent) * dir;
        case 'enrolled':
          return (new Date(a.enrolledAt).getTime() - new Date(b.enrolledAt).getTime()) * dir;
        case 'lastLogin': {
          const ta = a.lastLoginAt ? new Date(a.lastLoginAt).getTime() : 0;
          const tb = b.lastLoginAt ? new Date(b.lastLoginAt).getTime() : 0;
          return (ta - tb) * dir;
        }
      }
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  function handleExport() {
    if (!rows || rows.length === 0) return;
    const csv = enrollmentsToCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `alumnos-${courseId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const total = rows?.length ?? 0;
  const completed = rows?.filter((r) => r.status === 'COMPLETED').length ?? 0;
  const active = rows?.filter((r) => r.status === 'ACTIVE').length ?? 0;
  const avgProgress = total
    ? Math.round((rows ?? []).reduce((sum, r) => sum + r.progressPercent, 0) / total)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" asChild className="self-start">
          <Link href={`/formador/cursos/${courseId}` as never}>← Volver al curso</Link>
        </Button>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Alumnos del curso</h1>
          <p className="mt-1 text-text-muted">
            Quiénes están matriculados, cómo va su progreso y cuándo entraron por última vez.
          </p>
        </div>
        <Button variant="secondary" onClick={handleExport} disabled={!rows || rows.length === 0}>
          Exportar CSV
        </Button>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {rows ? (
        <div className="grid gap-4 sm:grid-cols-4">
          <StatCard label="Total" value={total} />
          <StatCard label="Activos" value={active} />
          <StatCard label="Completados" value={completed} />
          <StatCard label="Progreso promedio" value={`${avgProgress}%`} />
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="text-base">{total} matriculaciones</CardTitle>
              <CardDescription>Haz clic sobre las cabeceras para ordenar.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-text-muted" htmlFor="statusFilter">
                Estado
              </label>
              <Select
                id="statusFilter"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as EnrollmentStatus)}
                className="min-w-[160px]"
              >
                <option value="">Todos</option>
                <option value="ACTIVE">Activos</option>
                <option value="COMPLETED">Completados</option>
                <option value="CANCELLED">Cancelados</option>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {sorted === null ? (
            <div className="space-y-2 p-6">
              <div className="skeleton h-12 w-full" />
              <div className="skeleton h-12 w-full" />
              <div className="skeleton h-12 w-full" />
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-12 text-center">
              <h3 className="font-display text-xl font-semibold">No hay matriculaciones</h3>
              <p className="max-w-md text-text-muted">
                Cuando alguien se matricule en este curso, aparecerá acá. Puedes generar
                invitaciones desde la pestaña Invitaciones.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-6 py-3">
                      <SortHeader
                        active={sortKey === 'name'}
                        dir={sortDir}
                        onClick={() => handleSort('name')}
                      >
                        Alumno
                      </SortHeader>
                    </th>
                    <th className="px-3 py-3">Estado</th>
                    <th className="px-3 py-3">
                      <SortHeader
                        active={sortKey === 'progress'}
                        dir={sortDir}
                        onClick={() => handleSort('progress')}
                      >
                        Progreso
                      </SortHeader>
                    </th>
                    <th className="px-3 py-3">
                      <SortHeader
                        active={sortKey === 'enrolled'}
                        dir={sortDir}
                        onClick={() => handleSort('enrolled')}
                      >
                        Matriculado
                      </SortHeader>
                    </th>
                    <th className="px-6 py-3 text-right">
                      <SortHeader
                        active={sortKey === 'lastLogin'}
                        dir={sortDir}
                        onClick={() => handleSort('lastLogin')}
                      >
                        Último login
                      </SortHeader>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr
                      key={r.enrollmentId}
                      className="border-b border-border last:border-0 hover:bg-surface-2"
                    >
                      <td className="px-6 py-3">
                        <p className="font-semibold text-text">
                          {r.userName ?? r.userEmail ?? r.userId.slice(0, 8)}
                        </p>
                        {r.userName && r.userEmail ? (
                          <p className="text-xs text-text-subtle">{r.userEmail}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-3">
                            <div
                              className={
                                r.status === 'COMPLETED'
                                  ? 'h-full rounded-full bg-success-500'
                                  : 'h-full rounded-full bg-brand-500'
                              }
                              style={{ width: `${r.progressPercent}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-xs">{r.progressPercent}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs text-text-muted tabular-nums">
                        {formatDate(r.enrolledAt)}
                      </td>
                      <td className="px-6 py-3 text-right text-xs text-text-muted tabular-nums">
                        {r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleDateString('es-ES') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SortHeader({
  active,
  dir,
  onClick,
  children,
}: {
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide hover:text-text"
    >
      {children}
      {active ? <span aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
  );
}
