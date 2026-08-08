'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { StatCard } from '@/components/stat-card';
import { UserChip } from '@/components/user-chip';
import { coursesApi, type Course } from '@/lib/courses';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { labelOr, type TranslatorLike } from '@/lib/i18n/labels';
import {
  aiTutorReviewApi,
  type ListAnswersResultView,
  type ReviewAnswerView,
  type ReviewStatus,
} from './client';

/**
 * Pestaña "Revisión": el historial de lo que se le pregunta al tutor y lo que
 * contesta, con el veredicto de una persona.
 *
 * El filtro que de verdad importa es "sin respaldo": una respuesta sin ninguna
 * cita al material es la que más papeletas tiene de estar mal, porque el tutor
 * no encontró nada en qué apoyarse. Por eso el listado arranca con los
 * pendientes primero y el contador de pendientes está siempre a la vista.
 */

/**
 * El estado llega del backend: `labelOr` degrada a su valor crudo si algún día
 * aparece uno que el catálogo no conoce, nunca a una key en pantalla.
 */
function estadoLabel(t: TranslatorLike, status: ReviewStatus): string {
  return labelOr(t, `review.status.${status}`, status);
}

function formatFecha(iso: string): string {
  return formatDate(iso, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminTutorRevision(): React.JSX.Element {
  const t = useTranslations('modAiTutor');
  const tErrors = useTranslations('errors');
  const [data, setData] = useState<ListAnswersResultView | null>(null);
  const [cursos, setCursos] = useState<Course[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [courseId, setCourseId] = useState('');
  const [status, setStatus] = useState<'' | ReviewStatus>('');
  const [soloSinCitas, setSoloSinCitas] = useState(false);
  const [q, setQ] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [page, setPage] = useState(1);

  const [abierta, setAbierta] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const res = await aiTutorReviewApi.listAnswers({
      courseId: courseId || undefined,
      status: status || undefined,
      soloSinCitas: soloSinCitas || undefined,
      q: busqueda.length >= 2 ? busqueda : undefined,
      page,
      pageSize: 20,
    });
    setData(res);
  }, [courseId, status, soloSinCitas, busqueda, page]);

  useEffect(() => {
    cargar().catch((e) => {
      setError(apiErrorMessage(e, tErrors));
    });
    // `tErrors` fuera de deps: solo traduce el error de la carga.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargar]);

  useEffect(() => {
    coursesApi
      .list()
      .then(setCursos)
      .catch(() => {
        /* el filtro por curso es una comodidad, no bloquea la pantalla */
      });
  }, []);

  const revisar = useCallback(
    async (messageId: string, input: Parameters<typeof aiTutorReviewApi.review>[1]) => {
      setBusy(true);
      setError(null);
      try {
        await aiTutorReviewApi.review(messageId, input);
        setAbierta(null);
        await cargar();
      } catch (e) {
        setError(apiErrorMessage(e, tErrors));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cargar],
  );

  if (data === null && error === null) {
    return (
      <div className="space-y-2">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label={t('review.statFound')}
            value={data.total}
            hint={t('review.statFoundHint')}
            icon="message"
            tone="info"
          />
          <StatCard
            label={t('review.statPending')}
            value={data.pendientes}
            hint={t('review.statPendingHint')}
            icon="bell"
            tone={data.pendientes > 0 ? 'warn' : 'success'}
          />
          <StatCard
            label={t('review.statPage')}
            value={t('review.statPageValue', { page: data.page, total: totalPaginas })}
            hint={t('review.statPageHint', { size: data.pageSize })}
            icon="chart"
            tone="neutral"
          />
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('review.filtersTitle')}</CardTitle>
          <CardDescription>{t('review.filtersDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-sm">
              <span className="text-text-muted">{t('review.courseLabel')}</span>
              <NativeSelect
                value={courseId}
                data-testid="filtro-curso"
                onChange={(e) => {
                  setCourseId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">{t('review.allCourses')}</option>
                {cursos.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </NativeSelect>
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-text-muted">{t('review.statusLabel')}</span>
              <NativeSelect
                value={status}
                data-testid="filtro-estado"
                onChange={(e) => {
                  setStatus(e.target.value as '' | ReviewStatus);
                  setPage(1);
                }}
              >
                <option value="">{t('review.statusAll')}</option>
                <option value="PENDING">{t('review.statusPending')}</option>
                <option value="OK">{t('review.statusOk')}</option>
                <option value="CORRECTED">{t('review.statusCorrected')}</option>
              </NativeSelect>
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-text-muted">{t('review.searchLabel')}</span>
              <div className="flex gap-2">
                <Input
                  value={q}
                  placeholder={t('review.searchPlaceholder')}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    setBusqueda(q.trim());
                    setPage(1);
                  }}
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    setBusqueda(q.trim());
                    setPage(1);
                  }}
                >
                  {t('review.searchButton')}
                </Button>
              </div>
            </label>

            <label className="flex items-end gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 rounded border-border-strong"
                checked={soloSinCitas}
                data-testid="filtro-sin-respaldo"
                onChange={(e) => {
                  setSoloSinCitas(e.target.checked);
                  setPage(1);
                }}
              />
              <span className="pb-2.5 text-text">{t('review.onlyUnsupported')}</span>
            </label>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="tutor-answers-card">
        <CardHeader>
          <CardTitle>{t('review.listTitle')}</CardTitle>
          <CardDescription>{t('review.listDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!data || data.items.length === 0 ? (
            <p className="text-sm text-text-subtle">{t('review.listEmpty')}</p>
          ) : (
            data.items.map((item) => (
              <FilaRespuesta
                key={item.messageId}
                item={item}
                abierta={abierta === item.messageId}
                busy={busy}
                onToggle={() => setAbierta(abierta === item.messageId ? null : item.messageId)}
                onRevisar={revisar}
              />
            ))
          )}

          {data && data.total > data.pageSize ? (
            <div className="flex items-center justify-between pt-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t('review.previous')}
              </Button>
              <span className="text-xs text-text-subtle">
                {t('review.pageOf', { page: data.page, total: totalPaginas })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={data.page >= totalPaginas}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('review.next')}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function FilaRespuesta({
  item,
  abierta,
  busy,
  onToggle,
  onRevisar,
}: {
  item: ReviewAnswerView;
  abierta: boolean;
  busy: boolean;
  onToggle: () => void;
  onRevisar: (
    messageId: string,
    input: Parameters<typeof aiTutorReviewApi.review>[1],
  ) => Promise<void>;
}): React.JSX.Element {
  const t = useTranslations('modAiTutor');
  const [respuesta, setRespuesta] = useState(item.correction?.answer ?? item.answer);
  const [pregunta, setPregunta] = useState(item.correction?.question ?? item.question);
  const [nota, setNota] = useState(item.reviewNote ?? '');
  const [global, setGlobal] = useState(false);

  const sinRespaldo = item.citations.length === 0;

  // Cuatro frases completas en vez de trozos concatenados: la fecha y la nota
  // son opcionales y cada combinación tiene su propia key.
  const revisadaPor = (() => {
    const by = item.reviewedBy?.name ?? t('review.adminFallback');
    const date = item.reviewedAt ? formatFecha(item.reviewedAt) : null;
    const note = item.reviewNote;
    if (date && note) return t('review.reviewedByOnWithNote', { by, date, note });
    if (date) return t('review.reviewedByOn', { by, date });
    if (note) return t('review.reviewedByWithNote', { by, note });
    return t('review.reviewedBy', { by });
  })();

  return (
    <div
      className="rounded-lg border border-border-soft p-3"
      data-testid="tutor-answer-row"
      data-status={item.reviewStatus}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold text-text">{item.question}</p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-subtle">
            <UserChip
              userId={item.user.id}
              name={item.user.name}
              email={item.user.email}
              fallback={t('review.studentFallback')}
              showAvatar={false}
              size={18}
              nameClassName="block truncate text-xs text-text-subtle"
            />
            <span>
              {t('review.rowMeta', {
                course: item.courseTitle ?? t('review.courseFallback'),
                date: formatFecha(item.askedAt),
              })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sinRespaldo ? <Badge variant="warning">{t('review.unsupportedBadge')}</Badge> : null}
          <Badge
            variant={
              item.reviewStatus === 'OK'
                ? 'success'
                : item.reviewStatus === 'CORRECTED'
                  ? 'primary'
                  : 'muted'
            }
          >
            {estadoLabel(t, item.reviewStatus)}
          </Badge>
          <Button size="sm" variant="secondary" onClick={onToggle}>
            {abierta ? t('review.close') : t('review.open')}
          </Button>
        </div>
      </div>

      <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">{item.answer}</p>

      {item.citations.length > 0 ? (
        <p className="mt-1.5 text-xs text-text-subtle">
          {t('review.citations', {
            sources: item.citations
              .map((c) => c.lessonTitle ?? t('review.lessonFallback'))
              .join(' · '),
          })}
        </p>
      ) : null}

      {item.reviewStatus !== 'PENDING' ? (
        <p className="mt-1.5 text-xs text-text-subtle">{revisadaPor}</p>
      ) : null}

      {abierta ? (
        <div className="mt-3 space-y-3 border-t border-border-soft pt-3">
          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor={`pregunta-${item.messageId}`}>
              {t('review.canonicalQuestionLabel')}
            </label>
            <Input
              id={`pregunta-${item.messageId}`}
              value={pregunta}
              onChange={(e) => setPregunta(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor={`respuesta-${item.messageId}`}>
              {t('review.correctAnswerLabel')}
            </label>
            <Textarea
              id={`respuesta-${item.messageId}`}
              data-testid="respuesta-corregida"
              value={respuesta}
              rows={6}
              onChange={(e) => setRespuesta(e.target.value)}
            />
            <p className="text-xs text-text-subtle">{t('review.correctAnswerHint')}</p>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor={`nota-${item.messageId}`}>
              {t('review.noteLabel')}
            </label>
            <Input
              id={`nota-${item.messageId}`}
              value={nota}
              placeholder={t('review.notePlaceholder')}
              onChange={(e) => setNota(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-border-strong"
              checked={global}
              onChange={(e) => setGlobal(e.target.checked)}
            />
            <span className="text-text">{t('review.appliesToAll')}</span>
          </label>

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || respuesta.trim().length < 10}
              data-testid="guardar-correccion"
              onClick={() =>
                void onRevisar(item.messageId, {
                  status: 'CORRECTED',
                  respuestaCorregida: respuesta.trim(),
                  preguntaCanonica: pregunta.trim() || undefined,
                  nota: nota.trim() || undefined,
                  aplicaATodosLosCursos: global,
                })
              }
            >
              {t('review.saveCorrection')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              data-testid="marcar-correcta"
              onClick={() =>
                void onRevisar(item.messageId, {
                  status: 'OK',
                  nota: nota.trim() || undefined,
                })
              }
            >
              {t('review.markOk')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onToggle}>
              {t('review.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
