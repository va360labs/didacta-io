'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import {
  surveysApi,
  type SessionSurveyView,
  type SurveyAnswerInput,
  type SurveyQuestionView,
} from './client';

/**
 * Panel de la encuesta post-clase en /clase/[id]. Se renderiza solo si la
 * clase tiene encuesta (creada al terminar el directo o por el admin). La
 * respuesta es anónima; si el usuario ya respondió muestra el agradecimiento.
 */
export function SurveyPanel({ sessionId }: { sessionId: string }) {
  const [survey, setSurvey] = useState<SessionSurveyView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [values, setValues] = useState<Record<string, number>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surveysApi
      .getForSession(sessionId)
      .then((res) => {
        if (cancelled) return;
        setSurvey(res.survey);
        setLoaded(true);
      })
      .catch(() => {
        // Módulo inactivo o error transitorio: el panel simplemente no aparece.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!loaded || !survey) return null;

  if (survey.status !== 'OPEN' && !survey.alreadyAnswered && !done) return null;

  const thanks = survey.alreadyAnswered || done;
  const scored = survey.questions.filter((q) => q.type !== 'TEXT');
  const complete = scored.every((q) => typeof values[q.id] === 'number');

  async function submit() {
    if (!survey || busy || !complete) return;
    setBusy(true);
    setError(null);
    const answers: SurveyAnswerInput[] = [];
    for (const q of survey.questions) {
      if (q.type === 'TEXT') {
        const t = (text[q.id] ?? '').trim();
        if (t) answers.push({ questionId: q.id, valueText: t });
      } else {
        answers.push({ questionId: q.id, valueInt: values[q.id]! });
      }
    }
    try {
      await surveysApi.submit(survey.id, answers);
      setDone(true);
    } catch (e) {
      if (e instanceof ApiHttpError && e.status === 409) {
        // Ya respondida (otra pestaña, doble click…): mismo estado final.
        setDone(true);
      } else {
        setError(e instanceof ApiHttpError ? e.message : 'No pudimos enviar tu respuesta.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="survey-panel">
      <CardContent className="space-y-4 p-6">
        <div>
          <h2 className="text-base font-bold text-text">Valora esta clase</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            30 segundos. La respuesta es <strong>anónima</strong> — nos ayuda a decidir qué grabar y
            qué mejorar.
          </p>
        </div>

        {thanks ? (
          <p data-testid="survey-thanks" className="text-sm font-medium text-(--didacta-growth)">
            ¡Gracias por tu respuesta! La tenemos en cuenta para las próximas clases.
          </p>
        ) : (
          <>
            {survey.questions.map((q) => (
              <QuestionField
                key={q.id}
                question={q}
                value={values[q.id]}
                text={text[q.id] ?? ''}
                onValue={(v) => setValues((prev) => ({ ...prev, [q.id]: v }))}
                onText={(t) => setText((prev) => ({ ...prev, [q.id]: t }))}
              />
            ))}

            {error ? (
              <p role="alert" className="text-sm text-danger-700">
                {error}
              </p>
            ) : null}

            <Button onClick={() => void submit()} disabled={!complete || busy}>
              {busy ? 'Enviando…' : 'Enviar valoración'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function QuestionField({
  question,
  value,
  text,
  onValue,
  onText,
}: {
  question: SurveyQuestionView;
  value: number | undefined;
  text: string;
  onValue: (v: number) => void;
  onText: (t: string) => void;
}) {
  if (question.type === 'TEXT') {
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-text">{question.label}</p>
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Tu respuesta (opcional)"
          className="w-full rounded-lg border border-border bg-surface p-2.5 text-sm text-text placeholder:text-text-subtle focus:border-border-strong focus:outline-none"
        />
      </div>
    );
  }

  const options =
    question.type === 'NPS'
      ? Array.from({ length: 11 }, (_, i) => i)
      : Array.from({ length: 5 }, (_, i) => i + 1);

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-text">
        {question.label}
        {question.type === 'SCALE' ? (
          <span className="ml-1 text-xs font-normal text-text-muted">(1 = mal · 5 = genial)</span>
        ) : null}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onValue(n)}
            aria-pressed={value === n}
            aria-label={`${question.label}: ${n}`}
            className={`grid h-9 w-9 place-items-center rounded-lg border text-sm font-semibold transition-colors ${
              value === n
                ? 'border-transparent bg-(--didacta-trust) text-white'
                : 'border-border text-text-muted hover:border-border-strong hover:text-text'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      {question.type === 'NPS' ? (
        <p className="text-[11px] text-text-subtle">0 = nada probable · 10 = seguro que sí</p>
      ) : null}
    </div>
  );
}
