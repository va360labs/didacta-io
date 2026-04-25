import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-neutral-900 text-neutral-50 dark:bg-neutral-50 dark:text-neutral-900',
        outline:
          'border-neutral-200 text-neutral-700 dark:border-neutral-800 dark:text-neutral-300',
        success:
          'border-transparent bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100',
        warning:
          'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
        muted:
          'border-transparent bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
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
