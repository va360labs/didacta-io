'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { AccessChoice, AccessLevelOption } from '@/lib/access-levels';

interface Props {
  /** Prefijo de los `id` de los controles (hay formularios con dos campos). */
  idPrefix: string;
  value: AccessChoice;
  onChange: (next: AccessChoice) => void;
  /** Niveles del aula; `null` mientras cargan. */
  options: AccessLevelOption[] | null;
  /** Grande: el del modo sencillo (textos e interruptores más amplios). */
  size?: 'default' | 'large';
  /** Enseña «Marca al menos un nivel» (el formulario lo pide al guardar). */
  showIncomplete?: boolean;
  disabled?: boolean;
}

/**
 * «Quién puede verlo» de un espacio o un directo: «Todos los miembros» o «Solo
 * estos niveles», con una casilla por nivel. Calca los controles nativos de los
 * formularios hermanos (casillas de `h-4 w-4`, texto llano). Sin niveles en el
 * aula solo cabe «Todos los miembros» y una línea que dice por qué.
 */
export function AccessLevelsField({
  idPrefix,
  value,
  onChange,
  options,
  size = 'default',
  showIncomplete = false,
  disabled = false,
}: Props) {
  const t = useTranslations('comunidadComponentes.nivelAcceso');
  const large = size === 'large';
  const ids = value.mode === 'levels' ? value.ids : [];
  // Un nivel guardado que ya no existe no se pinta (ni cuenta como marcado).
  const known = new Set((options ?? []).map((o) => o.id));
  const anyChecked = ids.some((id) => known.has(id));
  const noLevels = options !== null && options.length === 0;

  function toggle(id: string, checked: boolean) {
    const next = checked ? [...new Set([...ids, id])] : ids.filter((x) => x !== id);
    onChange({ mode: 'levels', ids: next });
  }

  const optionCls = cn(
    'flex items-start gap-2.5 font-medium text-text',
    large ? 'text-base' : 'text-sm',
  );

  return (
    <fieldset className="space-y-2" data-testid={`${idPrefix}-quien`} disabled={disabled}>
      <legend className="text-sm font-semibold text-text">{t('quienPuedeVerlo')}</legend>
      <label className={optionCls} htmlFor={`${idPrefix}-todos`}>
        <input
          id={`${idPrefix}-todos`}
          type="radio"
          name={`${idPrefix}-quien`}
          checked={value.mode === 'all'}
          onChange={() => onChange({ mode: 'all' })}
          className="mt-0.5 h-4 w-4"
        />
        {t('todos')}
      </label>
      <label
        className={cn(optionCls, noLevels && 'text-text-subtle')}
        htmlFor={`${idPrefix}-niveles`}
      >
        <input
          id={`${idPrefix}-niveles`}
          type="radio"
          name={`${idPrefix}-quien`}
          checked={value.mode === 'levels'}
          disabled={noLevels}
          onChange={() => onChange({ mode: 'levels', ids })}
          className="mt-0.5 h-4 w-4"
        />
        {t('soloNiveles')}
      </label>

      {options === null ? (
        <p className="text-xs text-text-subtle">{t('cargando')}</p>
      ) : noLevels ? (
        <>
          <p className="text-xs text-text-subtle">{t('sinNiveles')}</p>
          {/* Estaba restringido a niveles que ya no existen: hay que elegir «Todos». */}
          {showIncomplete && value.mode === 'levels' ? (
            <p role="alert" className="text-xs font-semibold text-danger-700">
              {t('eligeUno')}
            </p>
          ) : null}
        </>
      ) : value.mode === 'levels' ? (
        <div className="ml-6 space-y-1.5 rounded-xl bg-bg-subtle p-3">
          {options.map((o) => (
            <label
              key={o.id}
              htmlFor={`${idPrefix}-nivel-${o.id}`}
              className={cn('flex items-center gap-2.5 text-text', large ? 'text-base' : 'text-sm')}
            >
              <input
                id={`${idPrefix}-nivel-${o.id}`}
                type="checkbox"
                checked={ids.includes(o.id)}
                onChange={(e) => toggle(o.id, e.target.checked)}
                className="h-4 w-4"
              />
              {o.name}
            </label>
          ))}
          <p className="pt-1 text-xs text-text-subtle">{t('soloNivelesAyuda')}</p>
          {showIncomplete && !anyChecked ? (
            <p role="alert" className="text-xs font-semibold text-danger-700">
              {t('eligeUno')}
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
