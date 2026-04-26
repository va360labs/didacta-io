import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-lg bg-surface px-3.5 py-2 pr-9',
        'text-[0.9375rem] text-text',
        'border border-border-strong appearance-none',
        // Caret custom — chevron SVG inline en color text-muted.
        'bg-[url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%2716%27%20height%3D%2716%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23667085%27%20stroke-width%3D%271.5%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27m6%209%206%206%206-6%27%2F%3E%3C%2Fsvg%3E")]',
        'bg-[length:16px] bg-[right_0.75rem_center] bg-no-repeat',
        'transition-[border-color,box-shadow] duration-150 ease-out',
        'focus-visible:outline-none focus-visible:border-brand-500 focus-visible:shadow-focus',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-surface-2',
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';
