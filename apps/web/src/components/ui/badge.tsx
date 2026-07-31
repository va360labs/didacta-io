/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums leading-tight',
  {
    variants: {
      variant: {
        // Brand
        default: 'bg-brand-500 text-text-on-brand',
        primary: 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200',
        // Outline neutral
        outline: 'bg-surface text-text-muted ring-1 ring-inset ring-border-strong',
        // Estados semánticos — alineados a `docs/ui-kit/ui_kits/learn/Primitives.jsx`.
        success:
          'bg-[var(--didacta-success-bg)] text-[var(--didacta-success-fg)] ring-1 ring-inset ring-success-200',
        info: 'bg-[var(--didacta-info-bg)] text-[var(--didacta-info-fg)] ring-1 ring-inset ring-brand-100',
        warning:
          'bg-[var(--didacta-warn-bg)] text-[var(--didacta-warn-fg)] ring-1 ring-inset ring-warning-200',
        danger:
          'bg-[var(--didacta-err-bg)] text-[var(--didacta-err-fg)] ring-1 ring-inset ring-danger-100',
        muted: 'bg-[var(--didacta-neutral-bg)] text-[var(--didacta-neutral-fg)]',
        /** Variant institucional — para certificados, cumplimiento, premium. */
        premium: 'bg-[var(--didacta-night)] text-white',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Punto coloreado a la izquierda del texto, siguiendo el spec del UI kit. */
  dot?: boolean;
}

export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? (
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      ) : null}
      {children}
    </span>
  );
}

export { badgeVariants };
