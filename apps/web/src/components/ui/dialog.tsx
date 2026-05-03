
'use client';

import * as React from 'react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

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
}

export function Dialog({
  open: controlledOpen,
  onOpenChange,
  children,
  title,
  description,
  ariaLabel,
  maxWidthClass = 'max-w-lg',
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
  const ctx = React.useContext(DialogContext);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => ctx?.onOpenChange(false), [ctx]);

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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      onClick={close}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative w-full max-w-lg rounded-lg border border-border bg-surface shadow-2xl outline-none',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={close}
          aria-label="Cerrar"
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
  maxWidthClass?: string;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={close}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? 'Dialog'}
        className={cn('relative w-full rounded-lg border bg-surface shadow-2xl', maxWidthClass)}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="border-b p-5">
            <h2 className="text-lg font-semibold">{title}</h2>
            {description && <p className="text-sm text-text-muted">{description}</p>}
          </div>
        )}
        <button
          type="button"
          onClick={close}
          aria-label="Cerrar"
          className="absolute right-3 top-3 rounded-md p-1 text-text-muted hover:text-text"
        >
          X
        </button>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
