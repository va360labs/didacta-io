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
import { coursesApi, type Course } from '@/lib/courses';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { aiTutorReviewApi, type CorrectionView } from './client';

/**
 * Pestaña "Conocimiento validado": las respuestas escritas por personas que el
 * tutor usa por encima del material del curso.
 *
 * Casi todas nacen de corregir una respuesta concreta en la pestaña de
 * revisión. Aquí se pueden editar, desactivar y —lo que más se usa— dar de alta
 * a mano, sin esperar a que alguien pregunte mal: si sabes que este mes van a
 * preguntar por las facturas, lo dejas escrito y el tutor ya lo sabe.
 */

function formatFecha(iso: string): string {
  return formatDate(iso, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function AdminTutorCorrecciones(): React.JSX.Element {
  const t = useTranslations('modAiTutor');
  const tErrors = useTranslations('errors');
  const [items, setItems] = useState<CorrectionView[] | null>(null);
  const [cursos, setCursos] = useState<Course[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [nuevaPregunta, setNuevaPregunta] = useState('');
  const [nuevaRespuesta, setNuevaRespuesta] = useState('');
  const [nuevoCurso, setNuevoCurso] = useState('');

  const cargar = useCallback(async () => {
    setItems(await aiTutorReviewApi.listCorrections());
  }, []);

  useEffect(() => {
    cargar().catch((e) => {
      setError(apiErrorMessage(e, tErrors));
    });
    coursesApi
      .list()
      .then(setCursos)
      .catch(() => {
        /* el selector de curso es opcional */
      });
    // `tErrors` queda fuera de deps a propósito: solo se usa para traducir el
    // error de la carga inicial, y next-intl ya devuelve un translator estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargar]);

  async function crear() {
    setBusy(true);
    setError(null);
    try {
      await aiTutorReviewApi.createCorrection({
        pregunta: nuevaPregunta.trim(),
        respuesta: nuevaRespuesta.trim(),
        courseId: nuevoCurso || null,
      });
      setNuevaPregunta('');
      setNuevaRespuesta('');
      setNuevoCurso('');
      await cargar();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function alternar(item: CorrectionView) {
    setBusy(true);
    setError(null);
    try {
      await aiTutorReviewApi.updateCorrection(item.id, { active: !item.active });
      await cargar();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function borrar(item: CorrectionView) {
    setBusy(true);
    setError(null);
    try {
      await aiTutorReviewApi.deleteCorrection(item.id);
      await cargar();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

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

      <Card>
        <CardHeader>
          <CardTitle>{t('corrections.createTitle')}</CardTitle>
          <CardDescription>{t('corrections.createDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor="nueva-pregunta">
              {t('corrections.questionLabel')}
            </label>
            <Input
              id="nueva-pregunta"
              data-testid="nueva-correccion-pregunta"
              value={nuevaPregunta}
              placeholder={t('corrections.questionPlaceholder')}
              onChange={(e) => setNuevaPregunta(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor="nueva-respuesta">
              {t('corrections.answerLabel')}
            </label>
            <Textarea
              id="nueva-respuesta"
              data-testid="nueva-correccion-respuesta"
              rows={5}
              value={nuevaRespuesta}
              onChange={(e) => setNuevaRespuesta(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor="nuevo-curso">
              {t('corrections.courseLabel')}
            </label>
            <NativeSelect
              id="nuevo-curso"
              value={nuevoCurso}
              onChange={(e) => setNuevoCurso(e.target.value)}
            >
              <option value="">{t('corrections.allCoursesOption')}</option>
              {cursos.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            data-testid="crear-correccion"
            disabled={busy || nuevaPregunta.trim().length < 3 || nuevaRespuesta.trim().length < 10}
            onClick={() => void crear()}
          >
            {t('corrections.save')}
          </Button>
        </CardContent>
      </Card>

      <Card data-testid="correcciones-card">
        <CardHeader>
          <CardTitle>{t('corrections.listTitle')}</CardTitle>
          <CardDescription>
            {items === null
              ? t('corrections.loading')
              : t('corrections.listDescription', { count: items.length })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {items === null ? (
            <div className="skeleton h-24 w-full" />
          ) : items.length === 0 ? (
            <p className="text-sm text-text-subtle">{t('corrections.empty')}</p>
          ) : (
            items.map((c) => (
              <div key={c.id} className="rounded-lg border border-border-soft p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text">{c.question}</p>
                    <p className="mt-0.5 text-xs text-text-subtle">
                      {t('corrections.meta', {
                        course: c.courseTitle ?? t('corrections.allCourses'),
                        author: c.authorName ?? t('corrections.teamAuthor'),
                        date: formatFecha(c.createdAt),
                        times: c.timesUsed,
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={c.active ? 'success' : 'muted'}>
                      {c.active ? t('corrections.active') : t('corrections.inactive')}
                    </Badge>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void alternar(c)}
                    >
                      {c.active ? t('corrections.deactivate') : t('corrections.activate')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void borrar(c)}
                    >
                      {t('corrections.delete')}
                    </Button>
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">{c.answer}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
