'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiHttpError } from '@/lib/api-client';
import { assessmentsApi, type QuizFormadorView } from '@/lib/assessments';
import { QuizEditor } from './quiz-editor';

export default function QuizEditorPage() {
  const params = useParams<{ id: string }>();
  const [quiz, setQuiz] = useState<QuizFormadorView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!params?.id) return;
    try {
      setQuiz(await assessmentsApi.getQuizForFormador(params.id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al cargar el quiz');
    }
  }

  useEffect(() => {
    void reload();
  }, [params?.id]);

  if (error)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!quiz) return <p className="text-sm text-neutral-500">Cargando…</p>;

  return (
    <div className="space-y-4">
      <Link
        href="/formador/cursos"
        className="text-xs text-neutral-500 underline decoration-dotted hover:decoration-solid"
      >
        ← Volver a mis cursos
      </Link>
      <QuizEditor initial={quiz} onChange={reload} />
    </div>
  );
}
