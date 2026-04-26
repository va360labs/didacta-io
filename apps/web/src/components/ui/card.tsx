import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Si la tarjeta es interactiva (link/click), aplicamos hover lift sutil.
   * Setealo desde fuera con data-interactive="true" o pasando el flag.
   */
  interactive?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive, ...props }, ref) => (
    <div
      ref={ref}
      data-interactive={interactive ? 'true' : undefined}
      className={cn(
        'bg-surface text-text border border-border rounded-card shadow-sm',
        'data-[interactive=true]:transition-[box-shadow,transform] data-[interactive=true]:duration-200 data-[interactive=true]:ease-out',
        'data-[interactive=true]:hover:shadow-lg data-[interactive=true]:hover:-translate-y-px',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1.5 p-6 pb-4', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn(
        'text-xl font-semibold leading-tight tracking-tight text-text font-display',
        className,
      )}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

export const CardDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-sm text-text-muted leading-relaxed', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center gap-3 p-6 pt-0 border-t border-border mt-2', className)}
      {...props}
    />
  ),
);
CardFooter.displayName = 'CardFooter';
