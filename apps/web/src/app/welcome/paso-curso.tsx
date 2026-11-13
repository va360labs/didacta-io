'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { concederPaseDeBienvenida } from '@/lib/academy';
import { coursesApi, type Course } from '@/lib/courses';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

interface Props {
  /** Avisa al pie de navegación: con un curso en el aula, el paso está hecho. */
  onHecho: (hecho: boolean) => void;
}

/**
 * Paso «curso»: el primer curso se crea AQUÍ, no en otra pestaña.
 *
 * Solo pide el título — el resto (lecciones, descripción, portada) pertenece al
 * editor de cursos, y pedirlo aquí convertiría el asistente en un formulario
 * largo. El curso nace en borrador, así que no hay riesgo de publicar nada a
 * medias por accidente.
 */
export function PasoCurso({ onHecho }: Props) {
  const t = useTranslations('bienvenida');
  const [titulo, setTitulo] = useState('');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creado, setCreado] = useState<Course | null>(null);
  const [existentes, setExistentes] = useState<number | null>(null);

  useEffect(() => {
    let cancelado = false;
    coursesApi
      .list()
      .then((cursos) => {
        if (cancelado) return;
        setExistentes(cursos.length);
        if (cursos.length > 0) onHecho(true);
      })
      .catch(() => {
        // Sin lista no pasa nada: se enseña el formulario igual.
        if (!cancelado) setExistentes(0);
      });
    return () => {
      cancelado = true;
    };
  }, [onHecho]);

  async function crear() {
    const limpio = titulo.trim();
    if (!limpio) {
      setError(t('cursoVacio'));
      return;
    }
    setError(null);
    setCreando(true);
    try {
      let curso: Course;
      try {
        curso = await coursesApi.create({ slug: slugify(limpio) || 'curso', title: limpio });
      } catch (e) {
        // Colisión de slug (p. ej. dos cursos con el mismo título): un sufijo
        // corto lo resuelve sin molestar a quien solo escribió un título.
        if (e instanceof ApiHttpError && e.status === 409) {
          const sufijo = Math.random().toString(36).slice(2, 6);
          curso = await coursesApi.create({
            slug: `${slugify(limpio) || 'curso'}-${sufijo}`,
            title: limpio,
          });
        } else {
          throw e;
        }
      }
      setCreado(curso);
      setTitulo('');
      onHecho(true);
    } catch {
      setError(t('cursoError'));
    } finally {
      setCreando(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('cursoTitulo')}</h1>
        <p className="text-text-muted">{t('cursoCuerpo')}</p>
      </header>

      {existentes !== null && existentes > 0 && !creado && (
        <p className="flex items-start gap-2 rounded-lg bg-success-50 p-3 text-sm text-success-700">
          <Icon name="check" size={16} className="mt-0.5 shrink-0" />
          {t('cursoYaTienes', { n: existentes })}
        </p>
      )}

      {creado ? (
        <div className="space-y-3 rounded-xl border border-border bg-surface-2 p-5">
          <p className="flex items-start gap-2 font-medium text-success-700">
            <Icon name="check" size={18} className="mt-0.5 shrink-0" />
            {t('cursoCreado', { titulo: creado.title })}
          </p>
          <p className="text-sm text-text-muted">{t('cursoCreadoAyuda')}</p>
          <a
            href={`/studio/courses/${creado.id}`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline"
            onClick={() => {
              // Sin el pase, el gate del shell devuelve la pestaña nueva a
              // /welcome (el asistente aún no está completado).
              concederPaseDeBienvenida();
            }}
          >
            {t('cursoAbrirEditor')}
            <Icon name="arrow-right" size={14} />
          </a>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="titulo-curso">{t('cursoNombre')}</Label>
            <Input
              id="titulo-curso"
              value={titulo}
              maxLength={160}
              autoFocus
              placeholder={t('cursoPlaceholder')}
              onChange={(e) => setTitulo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void crear();
              }}
            />
          </div>
          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-sm text-danger-700">
              <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}
          <Button type="button" onClick={() => void crear()} disabled={creando}>
            {creando ? t('cursoCreando') : t('cursoCrear')}
          </Button>
        </div>
      )}
    </div>
  );
}
