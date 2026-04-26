'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { assessmentsApi, type AttemptSummary } from '@/lib/assessments';

interface PendingAttempt extends AttemptSummary {
  quiz: { id: string; title: string; lessonId: string | null };
  answers: { id: string; questionId: string }[];
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const days = Math.floor(diffMs / 86_400_000);
    if (days < 1) return 'hoy';
    if (days === 1) return 'ayer';
    if (days < 7) return `hace ${days} días`;
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
  } catch {
    return iso;
  }
}

export default function CorreccionesPage() {
  const [pending, setPending] = useState<PendingAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setPending(await assessmentsApi.listPendingReview());
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos cargar la lista. Probá refrescar la página.',
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Correcciones pendientes</h1>
        <p className="mt-1 max-w-3xl text-text-muted">
          Intentos esperando tu corrección. Tras calificar, se emite el resultado y la lección queda
          completada si el alumno aprobó.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {pending === null ? (
        <div className="space-y-3">
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </div>
      ) : pending.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              className="flex h-20 w-20 items-center justify-center rounded-full bg-success-50 text-success-700 text-3xl"
              aria-hidden="true"
            >
              ✓
            </div>
            <h3 className="font-display text-xl font-semibold">Estás al día</h3>
            <p className="max-w-md text-text-muted">
              No hay intentos pendientes de corrección. Te avisaremos cuando algún alumno envíe un
              quiz con respuestas abiertas.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {pending.map((p) => (
            <li key={p.id}>
              <Link
                href={`/formador/correcciones/${p.id}`}
                className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <Card interactive>
                  <CardContent className="flex flex-wrap items-start justify-between gap-3 p-5">
                    <div className="min-w-0 flex-1 space-y-1">
                      <h3 className="font-display text-lg font-semibold text-text">
                        {p.quiz.title}
                      </h3>
                      <p className="text-sm text-text-muted">
                        {p.answers.length} respuesta{p.answers.length === 1 ? '' : 's'} para
                        corregir
                      </p>
                      <p className="text-xs text-text-subtle tabular-nums">
                        Enviado{' '}
                        {p.submittedAt
                          ? formatRelative(p.submittedAt)
                          : 'hace un tiempo desconocido'}
                      </p>
                    </div>
                    <Badge variant="warning">Pendiente</Badge>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
