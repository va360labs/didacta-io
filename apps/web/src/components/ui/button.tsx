import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold',
    'transition-[background-color,box-shadow,transform] duration-150 ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    'active:translate-y-px',
    'disabled:pointer-events-none disabled:opacity-50',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: 'bg-brand-500 text-text-on-brand shadow-sm hover:bg-brand-600 active:bg-brand-700',
        secondary:
          'bg-surface text-text border border-border-strong hover:bg-surface-2 hover:border-border-strong',
        success:
          'bg-success-500 text-text-on-brand shadow-sm hover:bg-success-600 active:bg-success-700',
        destructive:
          'bg-danger-500 text-text-on-brand shadow-sm hover:bg-danger-600 active:bg-danger-700',
        ghost: 'text-text hover:bg-surface-3',
        link: 'text-brand-500 underline-offset-4 hover:underline',
        // Alias para compat con código existente que usa "default" | "outline".
        default: 'bg-brand-500 text-text-on-brand shadow-sm hover:bg-brand-600 active:bg-brand-700',
        outline:
          'bg-surface text-text border border-border-strong hover:bg-surface-2 hover:border-border-strong',
      },
      size: {
        sm: 'h-8 px-3 text-sm rounded-md gap-1.5',
        default: 'h-10 px-5 text-[0.9375rem] rounded-lg',
        lg: 'h-12 px-6 text-base rounded-lg',
        icon: 'h-10 w-10 rounded-lg',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
