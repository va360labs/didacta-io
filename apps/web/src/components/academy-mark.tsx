/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { CSSProperties } from 'react';
import {
  academyInitials,
  academyMarkColors,
  NEUTRAL_GLYPH_PATHS,
  NEUTRAL_MARK_COLORS,
} from '@/lib/academy-mark';
import { cn } from '@/lib/utils';

interface Props {
  /** Nombre del aula. Sin letras (o `neutral`) → el símbolo neutro en gris. */
  name: string | null | undefined;
  /** Color de marca del aula (mod.theming). Sin él, el de por defecto. */
  hue?: number | null;
  saturation?: number | null;
  /** Lado en píxeles: el mismo que tendría el logo en ese sitio. */
  size: number;
  /** Esquinas: la clase de radio del logo al que sustituye (`rounded-lg`…). */
  className?: string;
  /**
   * El aula todavía no tiene nombre propio (p. ej. el que se dedujo del
   * correo de su dueña): símbolo neutro, sin iniciales de nadie.
   */
  neutral?: boolean;
  style?: CSSProperties;
}

/**
 * MARCA POR DEFECTO DEL AULA: sus iniciales sobre su color, en el hueco y con
 * la forma del logo, cuando el creador no ha subido uno. Nunca el logo de
 * Didacta (decisión de Valentín, 14-nov-2026). Lógica en `lib/academy-mark.ts`.
 *
 * Decorativa (`aria-hidden`): en todos los sitios el nombre del aula va al lado
 * o en la etiqueta del enlace que la envuelve. Sin estado ni efectos: sirve en
 * componentes de servidor y de cliente.
 */
export function AcademyMark({ name, hue, saturation, size, className, neutral, style }: Props) {
  const initials = neutral ? '' : academyInitials(name);
  const colors = initials ? academyMarkColors(hue, saturation) : NEUTRAL_MARK_COLORS;
  const glyph = Math.round(size * 0.56);
  return (
    <span
      aria-hidden="true"
      data-testid="academy-mark"
      data-initials={initials}
      className={cn(
        'inline-grid shrink-0 select-none place-items-center overflow-hidden rounded-lg font-extrabold leading-none',
        className,
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: colors.background,
        color: colors.foreground,
        fontSize: Math.round(size * (initials.length > 1 ? 0.4 : 0.46)),
        letterSpacing: initials.length > 1 ? '-0.02em' : undefined,
        ...style,
      }}
    >
      {initials || (
        <svg
          width={glyph}
          height={glyph}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {NEUTRAL_GLYPH_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      )}
    </span>
  );
}
