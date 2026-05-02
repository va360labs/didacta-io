'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiHttpError } from '@/lib/api-client';
import { assessmentsApi, type QuizFormadorView } from '@/modules/assessments';
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
      <div className="space-y-4">
        <Button asChild variant="ghost" className="self-start">
          <Link href="/formador/cursos">← Volver a mis cursos</Link>
        </Button>
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      </div>
    );

  if (!quiz)
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-32" />
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-64 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/formador/cursos">← Volver a mis cursos</Link>
      </Button>
      <QuizEditor initial={quiz} onChange={reload} />
    </div>
  );
}
