'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { StatCard } from '@/components/stat-card';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type Course } from '@/lib/courses';
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

const ESTADO_LABEL: Record<ReviewStatus, string> = {
  PENDING: 'Sin revisar',
  OK: 'Correcta',
  CORRECTED: 'Corregida',
};

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminTutorRevision(): React.JSX.Element {
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las conversaciones.');
    });
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
        setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la revisión.');
      } finally {
        setBusy(false);
      }
    },
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
            label="Preguntas encontradas"
            value={data.total}
            hint="con los filtros actuales"
            icon="message"
            tone="info"
          />
          <StatCard
            label="Sin revisar"
            value={data.pendientes}
            hint="esperan veredicto"
            icon="bell"
            tone={data.pendientes > 0 ? 'warn' : 'success'}
          />
          <StatCard
            label="Página"
            value={`${data.page} / ${totalPaginas}`}
            hint={`${data.pageSize} por página`}
            icon="chart"
            tone="neutral"
          />
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
          <CardDescription>
            «Solo sin respaldo» enseña las respuestas que el tutor dio sin poder citar ninguna
            lección. Son las que más probablemente estén mal o señalen material que falta.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-sm">
              <span className="text-text-muted">Curso</span>
              <NativeSelect
                value={courseId}
                data-testid="filtro-curso"
                onChange={(e) => {
                  setCourseId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Todos los cursos</option>
                {cursos.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </NativeSelect>
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-text-muted">Estado</span>
              <NativeSelect
                value={status}
                data-testid="filtro-estado"
                onChange={(e) => {
                  setStatus(e.target.value as '' | ReviewStatus);
                  setPage(1);
                }}
              >
                <option value="">Todos</option>
                <option value="PENDING">Sin revisar</option>
                <option value="OK">Correctas</option>
                <option value="CORRECTED">Corregidas</option>
              </NativeSelect>
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-text-muted">Buscar en la pregunta o la respuesta</span>
              <div className="flex gap-2">
                <Input
                  value={q}
                  placeholder="p. ej. certificado"
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
                  Buscar
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
              <span className="pb-2.5 text-text">Solo sin respaldo</span>
            </label>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="tutor-answers-card">
        <CardHeader>
          <CardTitle>Preguntas al tutor</CardTitle>
          <CardDescription>Las más recientes primero.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!data || data.items.length === 0 ? (
            <p className="text-sm text-text-subtle">
              No hay preguntas con estos filtros. Cuando un alumno pregunte al tutor desde una
              clase, aparecerá aquí.
            </p>
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
                Anterior
              </Button>
              <span className="text-xs text-text-subtle">
                {data.page} de {totalPaginas}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={data.page >= totalPaginas}
                onClick={() => setPage((p) => p + 1)}
              >
                Siguiente
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
  const [respuesta, setRespuesta] = useState(item.correction?.answer ?? item.answer);
  const [pregunta, setPregunta] = useState(item.correction?.question ?? item.question);
  const [nota, setNota] = useState(item.reviewNote ?? '');
  const [global, setGlobal] = useState(false);

  const sinRespaldo = item.citations.length === 0;

  return (
    <div
      className="rounded-lg border border-border-soft p-3"
      data-testid="tutor-answer-row"
      data-status={item.reviewStatus}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold text-text">{item.question}</p>
          <p className="text-xs text-text-subtle">
            {item.user.name ?? item.user.email ?? 'Alumno'} · {item.courseTitle ?? 'Curso'} ·{' '}
            {formatFecha(item.askedAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sinRespaldo ? <Badge variant="warning">Sin respaldo</Badge> : null}
          <Badge
            variant={
              item.reviewStatus === 'OK'
                ? 'success'
                : item.reviewStatus === 'CORRECTED'
                  ? 'primary'
                  : 'muted'
            }
          >
            {ESTADO_LABEL[item.reviewStatus]}
          </Badge>
          <Button size="sm" variant="secondary" onClick={onToggle}>
            {abierta ? 'Cerrar' : 'Revisar'}
          </Button>
        </div>
      </div>

      <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">{item.answer}</p>

      {item.citations.length > 0 ? (
        <p className="mt-1.5 text-xs text-text-subtle">
          Se apoyó en: {item.citations.map((c) => c.lessonTitle ?? 'lección').join(' · ')}
        </p>
      ) : null}

      {item.reviewStatus !== 'PENDING' ? (
        <p className="mt-1.5 text-xs text-text-subtle">
          Revisada por {item.reviewedBy?.name ?? 'un admin'}
          {item.reviewedAt ? ` el ${formatFecha(item.reviewedAt)}` : ''}
          {item.reviewNote ? ` — ${item.reviewNote}` : ''}
        </p>
      ) : null}

      {abierta ? (
        <div className="mt-3 space-y-3 border-t border-border-soft pt-3">
          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor={`pregunta-${item.messageId}`}>
              Pregunta con la que se guardará (generalízala si la original es muy suya)
            </label>
            <Input
              id={`pregunta-${item.messageId}`}
              value={pregunta}
              onChange={(e) => setPregunta(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor={`respuesta-${item.messageId}`}>
              Respuesta correcta
            </label>
            <Textarea
              id={`respuesta-${item.messageId}`}
              data-testid="respuesta-corregida"
              value={respuesta}
              rows={6}
              onChange={(e) => setRespuesta(e.target.value)}
            />
            <p className="text-xs text-text-subtle">
              Al guardar la corrección, el tutor la usará en las próximas preguntas parecidas, por
              encima del contenido del curso. No hace falta reindexar nada.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor={`nota-${item.messageId}`}>
              Nota interna (opcional)
            </label>
            <Input
              id={`nota-${item.messageId}`}
              value={nota}
              placeholder="p. ej. falta grabar la clase de facturación"
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
            <span className="text-text">Vale para todos los cursos, no solo para este</span>
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
              Guardar corrección
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
              Está bien
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onToggle}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
