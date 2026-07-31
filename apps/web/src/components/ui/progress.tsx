/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { cn } from '@/lib/utils';

interface Props {
  /** Valor 0..100. Se clampea automáticamente. */
  value: number;
  /** Color del fill. Default: success (Verde crecimiento). */
  tone?: 'success' | 'info' | 'warn';
  /** Altura en pixels. Default 8 (UI kit). */
  height?: number;
  className?: string;
  /** Aria label opcional para accesibilidad. */
  label?: string;
}

const TONE_CLASS: Record<NonNullable<Props['tone']>, string> = {
  success: 'bg-[var(--didacta-growth)]',
  info: 'bg-[var(--didacta-trust)]',
  warn: 'bg-[var(--didacta-coral)]',
};

/**
 * Progress bar siguiendo `docs/ui-kit/ui_kits/learn/Primitives.jsx > Progress`.
 *
 * Specs:
 *  - Track: `#F1F3F5` (didacta-surface).
 *  - Fill: tone correspondiente, transición .3s ease.
 *  - Border-radius pill (999px) en track y fill.
 */
export function Progress({ value, tone = 'success', height = 8, className, label }: Props) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('overflow-hidden rounded-full bg-[var(--didacta-surface)]', className)}
      style={{ height }}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', TONE_CLASS[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
