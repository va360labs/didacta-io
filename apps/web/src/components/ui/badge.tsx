import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums leading-tight',
  {
    variants: {
      variant: {
        // Brand
        default: 'bg-brand-500 text-text-on-brand',
        primary: 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200',
        // Outline neutral
        outline: 'bg-surface text-text-muted ring-1 ring-inset ring-border-strong',
        // Estados semánticos
        success: 'bg-success-50 text-success-700 ring-1 ring-inset ring-success-200',
        warning: 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-200',
        danger: 'bg-danger-50 text-danger-700 ring-1 ring-inset ring-danger-100',
        muted: 'bg-surface-3 text-text-muted',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
