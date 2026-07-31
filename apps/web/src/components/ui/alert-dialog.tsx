'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Dialog } from './dialog';

interface AlertDialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const AlertDialogContext = React.createContext<AlertDialogContextValue | null>(null);

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
  return (
    <AlertDialogContext.Provider value={{ open, onOpenChange }}>
      {children}
    </AlertDialogContext.Provider>
  );
}

export interface AlertDialogContentProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogContent({ children, className }: AlertDialogContentProps) {
  const context = React.useContext(AlertDialogContext);
  if (!context) throw new Error('AlertDialogContent must be used within AlertDialog');

  return (
    <Dialog
      open={context.open}
      onOpenChange={context.onOpenChange}
      ariaLabel="Alerta"
      maxWidthClass="max-w-md"
    >
      <div className={cn('space-y-4', className)}>{children}</div>
    </Dialog>
  );
}

export interface AlertDialogHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogHeader({ children, className }: AlertDialogHeaderProps) {
  return <div className={cn('space-y-2', className)}>{children}</div>;
}

export interface AlertDialogTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogTitle({ children, className }: AlertDialogTitleProps) {
  return (
    <h2 className={cn('font-display text-lg font-semibold text-text', className)}>{children}</h2>
  );
}

export interface AlertDialogDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogDescription({ children, className }: AlertDialogDescriptionProps) {
  return <p className={cn('text-sm text-text-muted', className)}>{children}</p>;
}

export interface AlertDialogFooterProps {
  children: React.ReactNode;
  className?: string;
}

export function AlertDialogFooter({ children, className }: AlertDialogFooterProps) {
  return <div className={cn('flex justify-end gap-3 pt-2', className)}>{children}</div>;
}

export interface AlertDialogActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive';
}

export function AlertDialogAction({
  children,
  className,
  variant = 'default',
  ...props
}: AlertDialogActionProps) {
  const context = React.useContext(AlertDialogContext);

  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        variant === 'destructive'
          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          : 'bg-brand-500 text-white hover:bg-brand-600',
        className,
      )}
      onClick={(e) => {
        props.onClick?.(e);
        context?.onOpenChange(false);
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export function AlertDialogCancel({
  children = 'Cancelar',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const context = React.useContext(AlertDialogContext);

  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium',
        'bg-surface text-text hover:bg-surface-2 transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      onClick={(e) => {
        props.onClick?.(e);
        context?.onOpenChange(false);
      }}
      {...props}
    >
      {children}
    </button>
  );
}
