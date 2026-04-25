'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiHttpError } from '@/lib/api-client';
import { assessmentsApi, type AttemptSummary } from '@/lib/assessments';

interface PendingAttempt extends AttemptSummary {
  quiz: { id: string; title: string; lessonId: string | null };
  answers: { id: string; questionId: string }[];
}

export default function CorreccionesPage() {
  const [pending, setPending] = useState<PendingAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setPending(await assessmentsApi.listPendingReview());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo cargar la lista');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  if (error)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!pending) return <p className="text-sm text-neutral-500">Cargando…</p>;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Correcciones pendientes</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Intentos en estado <strong>PENDING_REVIEW</strong> esperando tu corrección. Tras calificar
          se emite passed/failed y la lección queda completada si pasa.
        </p>
      </header>

      {pending.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No hay intentos pendientes. ✓
        </p>
      ) : (
        <ul className="space-y-3">
          {pending.map((p) => (
            <li key={p.id}>
              <Link
                href={`/formador/correcciones/${p.id}`}
                className="block rounded-md border border-neutral-200 p-4 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                <p className="font-medium">{p.quiz.title}</p>
                <p className="text-xs text-neutral-500">
                  Attempt {p.id.slice(0, 8)}… · enviado{' '}
                  {p.submittedAt ? new Date(p.submittedAt).toLocaleString() : '—'}
                </p>
                <p className="text-xs text-neutral-500">
                  {p.answers.length} respuesta{p.answers.length === 1 ? '' : 's'} a corregir
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
