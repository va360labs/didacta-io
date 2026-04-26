import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[96px] w-full rounded-lg bg-surface px-3.5 py-2.5',
      'text-[0.9375rem] text-text leading-relaxed',
      'border border-border-strong',
      'placeholder:text-text-subtle',
      'transition-[border-color,box-shadow] duration-150 ease-out',
      'focus-visible:outline-none focus-visible:border-brand-500 focus-visible:shadow-focus',
      'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-surface-2',
      'aria-[invalid=true]:border-danger-500',
      'resize-y',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
