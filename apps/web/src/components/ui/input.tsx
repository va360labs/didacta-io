/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-lg bg-surface px-3.5 py-2',
        'text-[0.9375rem] text-text',
        'border border-border-strong',
        'placeholder:text-text-subtle',
        'transition-[border-color,box-shadow] duration-150 ease-out',
        'focus-visible:outline-none focus-visible:border-brand-500 focus-visible:shadow-focus',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-surface-2',
        'aria-[invalid=true]:border-danger-500 aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_hsl(0_72%_50%/0.18)]',
        'file:bg-transparent file:text-sm file:font-medium file:border-0 file:mr-3',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
