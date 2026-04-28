'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * Dialog modal minimal — sin Radix. Cubre lo que necesitamos:
 *  - backdrop con click-fuera para cerrar
 *  - tecla Escape para cerrar
 *  - focus inicial en el primer interactivo del panel
 *  - role="dialog" + aria-modal="true" + aria-labelledby
 *  - bloquea scroll del body mientras está abierto
 *
 * No implementamos focus trap completo (bloquear Tab fuera del panel) para
 * mantenerlo chico; los modales del producto suelen ser cortos. Si en el
 * futuro un modal complejo lo necesita, agregamos `focus-trap-react` o
 * Radix Dialog acá adentro sin cambiar la API pública.
 */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Título visible del modal. Si se omite, el header con el título no se
   * renderiza (solo el botón de cerrar) y se usa `ariaLabel` para la
   * accesibilidad. Útil cuando el contenido ya trae su propia jerarquía
   * de encabezados (p.ej. el detalle de un post).
   */
  title?: ReactNode;
  description?: ReactNode;
  /** Etiqueta accesible cuando `title` es undefined. */
  ariaLabel?: string;
  children: ReactNode;
  /** Ancho máximo del panel. Default: 32rem (512px). */
  maxWidthClass?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  ariaLabel,
  children,
  maxWidthClass = 'max-w-lg',
}: DialogProps): React.JSX.Element | null {
  const titleId = useRef(`dialog-title-${Math.random().toString(36).slice(2, 8)}`).current;
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);

    // Bloquea scroll del body.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus inicial.
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelector<HTMLElement>(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    }, 0);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(focusTimer);
      previouslyFocused?.focus();
    };
  }, [open, close]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      onClick={close}
      aria-hidden="false"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        {...(title ? { 'aria-labelledby': titleId } : { 'aria-label': ariaLabel ?? 'Diálogo' })}
        className={cn(
          'relative w-full rounded-lg border border-border bg-surface shadow-2xl outline-none',
          maxWidthClass,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <div className="flex items-start justify-between gap-3 border-b border-border-soft p-5">
            <div className="min-w-0 flex-1 space-y-1">
              <h2 id={titleId} className="font-display text-lg font-semibold text-text">
                {title}
              </h2>
              {description ? <p className="text-sm text-text-muted">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Cerrar"
              className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              ✕
            </button>
          </div>
        ) : (
          // Sin título: el contenido trae su propia jerarquía. Mantenemos
          // sólo un botón flotante para cerrar.
          <button
            type="button"
            onClick={close}
            aria-label="Cerrar"
            className="absolute right-3 top-3 z-10 rounded-md bg-surface/80 p-1 text-text-muted backdrop-blur hover:bg-surface-2 hover:text-text focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            ✕
          </button>
        )}
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
