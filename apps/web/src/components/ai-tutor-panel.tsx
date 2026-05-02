'use client';

import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { aiTutorApi, type AskResponseView, type CitationView } from '@/lib/ai-tutor';

interface Props {
  courseId: string;
}

interface Turn {
  question: string;
  answer: string;
  citations: CitationView[];
  tokens: { input: number; output: number };
}

/**
 * Panel del tutor IA embebido al lado del player de la lección.
 *
 * El alumno escribe una pregunta sobre el curso, el backend hace RAG
 * sobre los chunks indexados (mod.ai-tutor) y devuelve respuesta + citas.
 *
 * Cada follow-up reusa `conversationId` para que el modelo tenga contexto
 * del diálogo previo (recortado por presupuesto de tokens en el backend).
 *
 * Errores semánticos del filtro `AiTutorErrorFilter`:
 *   - 404 AI_TUTOR_COURSE_NOT_INDEXED → mensaje amable + sugerir admin.
 *   - 422 AI_TUTOR_COURSE_NOT_PUBLISHED → curso no publicado.
 *   - 424 AI_PROVIDER_NOT_CONFIGURED   → admin debe configurar provider.
 *   - 429 AI_TUTOR_TOKEN_QUOTA_EXCEEDED / AI_PROVIDER_RATE_LIMIT.
 *   - 502 AI_PROVIDER_UNAVAILABLE / *_PROVIDER_ERROR.
 */
export function AiTutorPanel({ courseId }: Props) {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<Turn[]>([]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3) return;
    setPending(true);
    setError(null);
    try {
      const r: AskResponseView = await aiTutorApi.ask(courseId, {
        question: q,
        conversationId,
      });
      setConversationId(r.conversationId);
      setTurns((prev) => [
        ...prev,
        {
          question: q,
          answer: r.answer,
          citations: r.citations,
          tokens: r.tokensUsed,
        },
      ]);
      setQuestion('');
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setPending(false);
    }
  }

  function reset() {
    setConversationId(undefined);
    setTurns([]);
    setError(null);
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-lg font-semibold text-text">Tutor IA</h3>
            <p className="text-xs text-text-subtle">
              Preguntá lo que quieras sobre el curso. Las respuestas se basan en el contenido
              publicado e incluyen citas a las lecciones.
            </p>
          </div>
          {turns.length > 0 ? (
            <Button type="button" size="sm" variant="ghost" onClick={reset}>
              Nuevo hilo
            </Button>
          ) : null}
        </div>

        {turns.length > 0 ? (
          <ul className="space-y-4">
            {turns.map((t, i) => (
              <li key={i} className="space-y-2">
                <div className="rounded-lg border border-border-soft bg-surface-2 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
                    Tu pregunta
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-text">{t.question}</p>
                </div>
                <div className="rounded-lg border border-trust-100 bg-trust-50/50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-trust-700">
                    Tutor
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text">
                    {t.answer}
                  </p>
                  {t.citations.length > 0 ? (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                        Citas
                      </p>
                      <ul className="space-y-1">
                        {t.citations.map((c, ci) => (
                          <li
                            key={`${c.lessonId}-${c.chunkOrdinal}-${ci}`}
                            className="text-xs text-text-subtle"
                          >
                            <span className="font-semibold text-text">
                              [{ci + 1}] {c.lessonTitle ?? 'Lección'}
                            </span>{' '}
                            — <span className="italic">{c.snippet}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <Badge variant="muted">{t.tokens.input + t.tokens.output} tokens</Badge>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-2">
          <Textarea
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ej.: ¿Qué diferencia hay entre un módulo y un componente?"
            maxLength={2000}
            disabled={pending}
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" disabled={pending || question.trim().length < 3}>
              {pending ? 'Pensando…' : 'Preguntar'}
            </Button>
          </div>
        </form>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function humanizeError(e: unknown): string {
  if (!(e instanceof ApiHttpError)) return 'No pudimos contactar al tutor. Probá de nuevo.';
  switch (e.code) {
    case 'AI_TUTOR_COURSE_NOT_INDEXED':
      return 'Este curso aún no está indexado para el tutor IA. Avisá al administrador para que lo re-indexe.';
    case 'AI_TUTOR_COURSE_NOT_PUBLISHED':
      return 'El tutor IA solo opera sobre cursos publicados.';
    case 'AI_TUTOR_TOKEN_QUOTA_EXCEEDED':
      return 'Se alcanzó el límite de tokens para el tutor. Probá más tarde.';
    case 'AI_PROVIDER_NOT_CONFIGURED':
      return 'No hay proveedor de IA configurado en el tenant. Pídele al admin que configure uno.';
    case 'AI_PROVIDER_RATE_LIMIT':
      return 'El proveedor de IA está saturado ahora mismo. Probá en unos segundos.';
    case 'AI_PROVIDER_AUTH':
      return 'Las credenciales del proveedor de IA no son válidas. Avisá al admin.';
    case 'AI_PROVIDER_UNAVAILABLE':
    case 'AI_TUTOR_CHAT_PROVIDER_ERROR':
    case 'AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR':
      return 'El proveedor de IA no respondió. Probá de nuevo en un momento.';
    default:
      return e.message;
  }
}
