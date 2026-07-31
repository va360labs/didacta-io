'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { coursesApi, type Course } from '@/lib/courses';
import { learningApi, type Enrollment } from '@/lib/learning';

interface EnrollmentWithCourse extends Enrollment {
  courseTitle: string;
}

export default function MiPanelPage() {
  const [loading, setLoading] = useState(true);
  const [enrollments, setEnrollments] = useState<EnrollmentWithCourse[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [rawEnrollments, courses] = await Promise.all([
          learningApi.listMine(),
          coursesApi.list({ status: 'PUBLISHED' }),
        ]);
        if (cancelled) return;
        const courseMap = new Map<string, Course>(courses.map((c) => [c.id, c]));
        const active = rawEnrollments
          .filter((e) => e.status === 'ACTIVE')
          .map((e) => ({
            ...e,
            courseTitle: courseMap.get(e.courseId)?.title ?? e.courseId,
          }));
        setEnrollments(active);
      } catch {
        if (!cancelled) setError('No se pudo cargar el panel. Inténtalo de nuevo.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const avgProgress =
    enrollments.length > 0
      ? Math.round(enrollments.reduce((sum, e) => sum + e.progressPercent, 0) / enrollments.length)
      : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">Mi panel</h1>
        <p className="mt-1 text-sm text-text-muted">Tu actividad y progreso en la comunidad</p>
      </div>

      {error && (
        <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">
          {error}
        </div>
      )}

      {/* Stat cards */}
      {!error && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Cursos en marcha"
            value={loading ? '—' : String(enrollments.length)}
            sub={
              loading
                ? 'Cargando…'
                : enrollments.length === 0
                  ? 'Sin matriculaciones'
                  : `${enrollments.filter((e) => e.progressPercent === 100).length} completados`
            }
          />
          <StatCard
            label="Progreso medio"
            value={loading ? '—' : avgProgress !== null ? `${avgProgress}%` : '—'}
            sub={
              loading
                ? 'Cargando…'
                : avgProgress !== null
                  ? 'Sobre tus cursos activos'
                  : 'Sin cursos activos'
            }
          />
          <StatCard
            label="Certificados"
            value={loading ? '—' : String(enrollments.filter((e) => e.completedAt).length)}
            sub={loading ? 'Cargando…' : 'Cursos completados'}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Cursos activos */}
        <div className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-3 font-semibold text-text">Mis cursos activos</h2>
          {loading ? (
            <p className="text-sm text-text-muted">Cargando…</p>
          ) : enrollments.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-text-muted">Aún no estás matriculado en ningún curso.</p>
              <Link
                href="/cursos"
                className="mt-2 inline-block text-sm font-medium text-(--didacta-trust) hover:underline"
              >
                Explorar cursos →
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {enrollments.map((e) => (
                <div key={e.id}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="truncate font-medium text-text">{e.courseTitle}</span>
                    <span className="ml-2 shrink-0 text-text-muted">{e.progressPercent}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                    <div
                      className="h-full rounded-full bg-(--didacta-trust)"
                      style={{ width: `${e.progressPercent}%` }}
                    />
                  </div>
                </div>
              ))}
              <Link
                href="/cursos"
                className="mt-1 block text-xs font-medium text-(--didacta-trust) hover:underline"
              >
                Ver todos los cursos →
              </Link>
            </div>
          )}
        </div>

        {/* Grupos */}
        <div className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-3 font-semibold text-text">Mis grupos</h2>
          <div className="py-6 text-center">
            <p className="text-sm text-text-muted">Los grupos estarán disponibles próximamente.</p>
            <Link
              href="/grupos"
              className="mt-2 inline-block text-sm font-medium text-(--didacta-trust) hover:underline"
            >
              Ver grupos →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {label}
      </p>
      <p className="mt-1 font-display text-2xl font-bold text-text">{value}</p>
      <p className="mt-0.5 text-xs text-text-muted">{sub}</p>
    </div>
  );
}
