'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type Course } from '@/lib/courses';
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
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function AdminTutorCorrecciones(): React.JSX.Element {
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
      setError(
        e instanceof ApiHttpError ? e.message : 'No pudimos cargar el conocimiento validado.',
      );
    });
    coursesApi
      .list()
      .then(setCursos)
      .catch(() => {
        /* el selector de curso es opcional */
      });
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la respuesta.');
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cambiar el estado.');
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos borrarla.');
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
          <CardTitle>Añadir una respuesta validada</CardTitle>
          <CardDescription>
            El tutor la usará cuando alguien pregunte algo parecido, por encima del contenido del
            curso. No hay que reindexar: entra en caliente.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor="nueva-pregunta">
              Pregunta
            </label>
            <Input
              id="nueva-pregunta"
              data-testid="nueva-correccion-pregunta"
              value={nuevaPregunta}
              placeholder="p. ej. ¿cómo descargo mi factura?"
              onChange={(e) => setNuevaPregunta(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-text-muted" htmlFor="nueva-respuesta">
              Respuesta
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
              Curso
            </label>
            <NativeSelect
              id="nuevo-curso"
              value={nuevoCurso}
              onChange={(e) => setNuevoCurso(e.target.value)}
            >
              <option value="">Todos los cursos (duda transversal)</option>
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
            Guardar
          </Button>
        </CardContent>
      </Card>

      <Card data-testid="correcciones-card">
        <CardHeader>
          <CardTitle>Conocimiento validado</CardTitle>
          <CardDescription>
            {items === null
              ? 'Cargando…'
              : `${items.length} respuesta${items.length !== 1 ? 's' : ''} escritas por el equipo.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {items === null ? (
            <div className="skeleton h-24 w-full" />
          ) : items.length === 0 ? (
            <p className="text-sm text-text-subtle">
              Todavía no hay ninguna. Se crean al corregir una respuesta en la pestaña «Revisión» o
              a mano aquí arriba.
            </p>
          ) : (
            items.map((c) => (
              <div key={c.id} className="rounded-lg border border-border-soft p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text">{c.question}</p>
                    <p className="mt-0.5 text-xs text-text-subtle">
                      {c.courseTitle ?? 'Todos los cursos'} · {c.authorName ?? 'equipo'} ·{' '}
                      {formatFecha(c.createdAt)} · usada {c.timesUsed}{' '}
                      {c.timesUsed === 1 ? 'vez' : 'veces'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={c.active ? 'success' : 'muted'}>
                      {c.active ? 'Activa' : 'Desactivada'}
                    </Badge>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void alternar(c)}
                    >
                      {c.active ? 'Desactivar' : 'Activar'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void borrar(c)}
                    >
                      Borrar
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
