'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { formatMmSs } from '@/lib/transcript';
import { aiTutorApi, type AskResponseView, type CitationView } from '@/modules/ai-tutor';

interface Props {
  courseId: string;
  /** Lección abierta ahora mismo. El tutor prioriza sus fragmentos. */
  lessonId?: string;
  /** Título de esa lección, para decírselo al alumno en la cabecera. */
  lessonTitle?: string;
  /** Segundo del vídeo en el que va, si el reproductor lo reporta. */
  positionSeconds?: number;
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
export function AiTutorPanel({ courseId, lessonId, lessonTitle, positionSeconds }: Props) {
  const t = useTranslations('playersContenido');
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [quota, setQuota] = useState<{ remaining: number; limit: number } | null>(null);

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
        // Sin esto el tutor es un buscador del curso entero: no sabe que la
        // duda es de la clase que el alumno tiene delante ni por dónde va.
        lessonId,
        positionSeconds,
      });
      setConversationId(r.conversationId);
      setQuota({ remaining: r.quota.remaining, limit: r.quota.limit });
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
      setError(humanizeError(e, t));
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
            <h3 className="font-display text-lg font-semibold text-text">{t('aiTutor.title')}</h3>
            <p className="text-xs text-text-subtle">
              {lessonTitle ? t('aiTutor.introWithLesson', { lessonTitle }) : t('aiTutor.intro')}
            </p>
            {quota ? (
              <p className="mt-1 text-[11px] text-text-subtle">
                {t.rich('aiTutor.quota', {
                  b: (chunks) => <strong>{chunks}</strong>,
                  remaining: quota.remaining,
                  limit: quota.limit,
                })}
              </p>
            ) : null}
          </div>
          {turns.length > 0 ? (
            <Button type="button" size="sm" variant="ghost" onClick={reset}>
              {t('aiTutor.newThread')}
            </Button>
          ) : null}
        </div>

        {turns.length > 0 ? (
          <ul className="space-y-4">
            {turns.map((turn, i) => (
              <li key={i} className="space-y-2">
                <div className="rounded-lg border border-border-soft bg-surface-2 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
                    {t('aiTutor.yourQuestion')}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-text">{turn.question}</p>
                </div>
                <div className="rounded-lg border border-trust-100 bg-trust-50/50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-trust-700">
                    {t('aiTutor.tutor')}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text">
                    {turn.answer}
                  </p>
                  {turn.citations.length > 0 ? (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                        {t('aiTutor.citations')}
                      </p>
                      <ul className="space-y-1">
                        {turn.citations.map((c, ci) => (
                          <li
                            key={`${c.lessonId}-${c.chunkOrdinal}-${ci}`}
                            className="text-xs text-text-subtle"
                          >
                            <span className="font-semibold text-text">
                              {t('aiTutor.citation', {
                                index: ci + 1,
                                title: c.lessonTitle ?? t('aiTutor.citationLessonFallback'),
                              })}
                            </span>
                            {c.startSeconds !== null ? (
                              <span className="ml-1 font-mono text-[11px] text-brand">
                                {t('aiTutor.citationMinute', {
                                  time: formatMmSs(c.startSeconds),
                                })}
                              </span>
                            ) : null}{' '}
                            — <span className="italic">{c.snippet}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <Badge variant="muted">
                      {t('aiTutor.tokens', { tokens: turn.tokens.input + turn.tokens.output })}
                    </Badge>
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
            placeholder={t('aiTutor.questionPlaceholder')}
            maxLength={2000}
            disabled={pending}
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" disabled={pending || question.trim().length < 3}>
              {pending ? t('aiTutor.askPending') : t('aiTutor.ask')}
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

/**
 * El copy de estos códigos es específico del alumno hablando con el tutor (no
 * genérico del backend), por eso vive en `playersContenido` y no en `errors`.
 */
function humanizeError(e: unknown, t: TranslatorLike): string {
  if (!(e instanceof ApiHttpError)) return t('aiTutor.errors.fallback');
  switch (e.code) {
    case 'AI_TUTOR_COURSE_NOT_INDEXED':
      return t('aiTutor.errors.AI_TUTOR_COURSE_NOT_INDEXED');
    case 'AI_TUTOR_COURSE_NOT_PUBLISHED':
      return t('aiTutor.errors.AI_TUTOR_COURSE_NOT_PUBLISHED');
    case 'AI_TUTOR_TOKEN_QUOTA_EXCEEDED':
      return t('aiTutor.errors.AI_TUTOR_TOKEN_QUOTA_EXCEEDED');
    case 'AI_PROVIDER_NOT_CONFIGURED':
      return t('aiTutor.errors.AI_PROVIDER_NOT_CONFIGURED');
    case 'AI_PROVIDER_RATE_LIMIT':
      return t('aiTutor.errors.AI_PROVIDER_RATE_LIMIT');
    case 'AI_PROVIDER_AUTH':
      return t('aiTutor.errors.AI_PROVIDER_AUTH');
    case 'AI_PROVIDER_UNAVAILABLE':
    case 'AI_TUTOR_CHAT_PROVIDER_ERROR':
    case 'AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR':
      return t('aiTutor.errors.AI_PROVIDER_UNAVAILABLE');
    default:
      return e.message;
  }
}
