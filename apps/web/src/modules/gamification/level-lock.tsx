'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { retentionApi, type MyLock } from './retention-client';

/** Lo mínimo para pintar un candado de nivel (de `/me/locks` o de la disponibilidad). */
export interface LevelLockLike {
  levelNumber: number;
  levelName: string;
  pointsMissing: number;
}

/**
 * Cierres por nivel que siguen cerrados para quien mira, por curso (solo los
 * del curso entero: las secciones las pinta el reproductor). Si el aula no
 * usa puntos, la API responde 403 y no hay candados.
 */
export function useCourseLevelLocks(): Map<string, MyLock> {
  const [map, setMap] = useState<Map<string, MyLock>>(new Map());
  useEffect(() => {
    let alive = true;
    retentionApi
      .myLocks()
      .then((locks) => {
        if (!alive) return;
        setMap(
          new Map(
            locks
              .filter((l) => l.targetKind === 'COURSE' && !l.unlocked)
              .map((l) => [l.courseId, l]),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return map;
}

/** «Se desbloquea en el nivel N — te faltan X puntos» (tarjeta del catálogo). */
export function LevelLockLine({
  lock,
  className = '',
}: {
  lock: LevelLockLike;
  className?: string;
}) {
  const t = useTranslations('modGamification.retencion.candado');
  return (
    <p
      className={`flex items-start gap-1.5 text-xs font-semibold text-text ${className}`}
      data-testid="candado-nivel"
    >
      <Icon name="lock" size={13} className="mt-0.5 shrink-0" />
      <span>
        {t('nivel', { number: lock.levelNumber })}
        {lock.pointsMissing > 0 ? ` — ${t('faltan', { count: lock.pointsMissing })}` : ''}
      </span>
    </p>
  );
}

/**
 * La pantalla con candado de un curso o una lección que se abren por nivel: qué
 * nivel, cuántos puntos faltan y cómo conseguirlos. Sin cuenta atrás ni
 * presión: se abrirá sola y se avisará.
 */
export function LevelLockedCard({
  lock,
  scope,
}: {
  lock: LevelLockLike;
  scope: 'course' | 'lesson';
}) {
  const t = useTranslations('modGamification.retencion.candado');
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface px-6 py-12 text-center"
      data-testid="candado-nivel-tarjeta"
    >
      <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-700">
        <Icon name="lock" size={22} />
      </span>
      <h3 className="font-display text-xl font-semibold text-text">
        {scope === 'course'
          ? t('tituloCurso', { number: lock.levelNumber })
          : t('tituloLeccion', { number: lock.levelNumber })}
      </h3>
      {lock.pointsMissing > 0 ? (
        <p className="text-sm font-semibold text-brand-700">
          {t('faltanFrase', { count: lock.pointsMissing })}
        </p>
      ) : null}
      <p className="max-w-md text-sm text-text-muted">{t('texto', { name: lock.levelName })}</p>
      <Link
        href="/challenges"
        className="mt-1 inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
      >
        {t('verRetos')}
      </Link>
    </div>
  );
}
