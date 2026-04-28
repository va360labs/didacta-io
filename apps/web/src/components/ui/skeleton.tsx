import { cn } from '@/lib/utils';

/**
 * Bloque animado de carga. Wrappea la clase global `.skeleton` (definida
 * en `globals.css` con `pulse-skeleton`) en un componente para que las
 * pantallas usen el mismo estilo que el resto del sistema de UI
 * (Card, Button, etc.). Equivalente al `<Skeleton>` de shadcn pero
 * conectado a nuestros tokens (`var(--color-surface-3)` y
 * `var(--radius-md)`).
 *
 * Uso típico:
 *   <Skeleton className="h-16 w-full" />
 *   <Skeleton className="h-32 w-full" />
 *
 * Acepta `width` y `height` como props sueltos para casos uniformes:
 *   <Skeleton h="h-12" />
 */
export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...props }: SkeletonProps): React.JSX.Element {
  return <div className={cn('skeleton', className)} aria-hidden="true" {...props} />;
}
