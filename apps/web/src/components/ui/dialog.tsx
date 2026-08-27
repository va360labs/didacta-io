'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import * as React from 'react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useFocusTrap } from '@/lib/use-focus-trap';

interface DialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  ariaLabel?: string;
  maxWidthClass?: string;
  /** Sobrescribe el padding interno del contenido (legacy). Default `p-5`. */
  contentClassName?: string;
}

export function Dialog({
  open: controlledOpen,
  onOpenChange,
  children,
  title,
  description,
  ariaLabel,
  maxWidthClass = 'max-w-lg',
  contentClassName,
}: DialogProps): React.JSX.Element | null {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen ?? internalOpen;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) {
        setInternalOpen(next);
      }
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  const isLegacyMode = title !== undefined || description !== undefined || ariaLabel !== undefined;

  if (isLegacyMode) {
    return (
      <DialogLegacy
        open={open}
        onOpenChange={handleOpenChange}
        title={title}
        description={description}
        ariaLabel={ariaLabel}
        maxWidthClass={maxWidthClass}
        contentClassName={contentClassName}
      >
        {children}
      </DialogLegacy>
    );
  }

  return (
    <DialogContext.Provider value={{ open, onOpenChange: handleOpenChange }}>
      {children}
    </DialogContext.Provider>
  );
}

export interface DialogTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export function DialogTrigger({ children, asChild, ...props }: DialogTriggerProps) {
  const ctx = React.useContext(DialogContext);
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<any>, {
      onClick: (e: React.MouseEvent) => {
        ctx?.onOpenChange(true);
        (children as any).props?.onClick?.(e);
      },
    });
  }
  return (
    <button type="button" onClick={() => ctx?.onOpenChange(true)} {...props}>
      {children}
    </button>
  );
}

export interface DialogContentProps {
  children: ReactNode;
  className?: string;
}

export function DialogContent({ children, className }: DialogContentProps) {
  // Antes de los early-returns de abajo: el orden de hooks no puede variar.
  const t = useTranslations('shell');
  const ctx = React.useContext(DialogContext);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => ctx?.onOpenChange(false), [ctx]);

  // Foco dentro al abrir, atrapado mientras está abierto y devuelto al cerrar.
  // `panelRef` existía desde siempre pero no lo leía nadie: el diálogo se
  // anunciaba como modal y dejaba el foco detrás. Ver `use-focus-trap.ts`.
  useFocusTrap(panelRef, ctx?.open ?? false);

  useEffect(() => {
    if (!ctx?.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [ctx?.open, close]);

  if (!ctx?.open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      {/* Fondo. Es un <button> y no un <div onClick> porque cerrar pulsando
          fuera ES una acción, y como <div> ni se anunciaba ni tenía etiqueta.
          Vive fuera del panel, así que la trampa de foco lo deja fuera del
          recorrido del tabulador — igual que hace cualquier modal: una zona de
          cierre a pantalla completa en medio del ciclo confunde más que ayuda.
          A quien navega con teclado le quedan Escape y la X de la esquina. */}
      <button
        type="button"
        aria-label={t('dialog.close')}
        onClick={close}
        className="fixed inset-0 -z-10 cursor-default bg-black/50"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        // Enfocable por programa: es el destino de respaldo cuando el diálogo
        // no tiene ningún control dentro. Fuera del recorrido del tabulador.
        tabIndex={-1}
        className={cn(
          'relative w-full max-w-lg rounded-lg border border-border bg-surface shadow-2xl outline-none',
          className,
        )}
      >
        <button
          type="button"
          onClick={close}
          aria-label={t('dialog.close')}
          className="absolute right-3 top-3 z-10 rounded-md p-1 text-text-muted hover:text-text"
        >
          X
        </button>
        <div className="p-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export interface DialogHeaderProps {
  children: ReactNode;
  className?: string;
}

export function DialogHeader({ children, className }: DialogHeaderProps) {
  return <div className={cn('space-y-1.5', className)}>{children}</div>;
}

export interface DialogTitleProps {
  children: ReactNode;
  className?: string;
}

export function DialogTitle({ children, className }: DialogTitleProps) {
  return <h2 className={cn('text-lg font-semibold', className)}>{children}</h2>;
}

export interface DialogDescriptionProps {
  children: ReactNode;
  className?: string;
}

export function DialogDescription({ children, className }: DialogDescriptionProps) {
  return <p className={cn('text-sm text-text-muted', className)}>{children}</p>;
}

export interface DialogFooterProps {
  children: ReactNode;
  className?: string;
}

export function DialogFooter({ children, className }: DialogFooterProps) {
  return <div className={cn('flex justify-end gap-2', className)}>{children}</div>;
}

function DialogLegacy({
  open,
  onOpenChange,
  title,
  description,
  ariaLabel,
  children,
  maxWidthClass = 'max-w-lg',
  contentClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
  maxWidthClass?: string;
  contentClassName?: string;
}): React.JSX.Element | null {
  // Antes de los early-returns de abajo: el orden de hooks no puede variar.
  const t = useTranslations('shell');
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Ver DialogContent: fondo como <button>, fuera del recorrido del
          tabulador; con teclado se cierra con Escape o con la X. */}
      <button
        type="button"
        aria-label={t('dialog.close')}
        onClick={close}
        className="fixed inset-0 -z-10 cursor-default bg-black/50"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={ariaLabel ?? t('dialog.fallbackLabel')}
        className={cn(
          'relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-lg border bg-surface shadow-2xl',
          maxWidthClass,
        )}
      >
        {title && (
          <div className="shrink-0 border-b p-5">
            <h2 className="text-lg font-semibold">{title}</h2>
            {description && <p className="text-sm text-text-muted">{description}</p>}
          </div>
        )}
        <button
          type="button"
          onClick={close}
          aria-label={t('dialog.close')}
          className="absolute right-3 top-3 z-10 rounded-md p-1 text-text-muted hover:text-text"
        >
          X
        </button>
        <div className={cn('min-h-0 flex-1 overflow-y-auto p-5', contentClassName)}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
