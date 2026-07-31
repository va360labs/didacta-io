'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

// ============================================================================
// Native Select (original simple wrapper)
// ============================================================================
export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'flex h-10 w-full rounded-lg bg-surface px-3.5 py-2 pr-9',
      'text-[0.9375rem] text-text',
      'border border-border-strong appearance-none',
      'bg-[url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%2716%27%20height%3D%2716%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23667085%27%20stroke-width%3D%271.5%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27m6%209%206%206%206-6%27%2F%3E%3C%2Fsvg%3E")]',
      'bg-[length:16px] bg-[right_0.75rem_center] bg-no-repeat',
      'transition-[border-color,box-shadow] duration-150 ease-out',
      'focus-visible:outline-none focus-visible:border-brand-500 focus-visible:shadow-focus',
      'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-surface-2',
      className,
    )}
    {...props}
  />
));
NativeSelect.displayName = 'NativeSelect';

// ============================================================================
// Enhanced Select (Radix-like API)
// ============================================================================
interface SelectContextValue {
  value: string;
  onValueChange: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SelectContext = React.createContext<SelectContextValue | null>(null);

export interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  required?: boolean;
  defaultValue?: string;
  // Support legacy onChange API
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
}

export function Select({
  value = '',
  onValueChange,
  children,
  disabled,
  className,
  id,
  onChange,
  name,
  required,
  defaultValue,
}: SelectProps) {
  const [open, setOpen] = React.useState(false);

  // Usage detection: la API nativa se distingue por tener hijos `<option>`
  // (ya sea controlada con `onChange`, o no controlada con `name`/`defaultValue`
  // dentro de un <form>). La API enhanced usa SelectTrigger/SelectContent/
  // SelectItem, nunca `<option>`. Sin este check, un Select no controlado (sin
  // `onChange`) caía a la rama enhanced y renderizaba los `<option>` como texto
  // suelto dentro de un <div>: no seleccionable y sin enviar valor en el submit.
  const hasOptionChildren = React.useMemo(() => {
    let found = false;
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.type === 'option') found = true;
    });
    return found;
  }, [children]);

  if (onChange || hasOptionChildren) {
    // Controlada (`onChange`) → pasamos `value`. No controlada (form nativo) →
    // solo `defaultValue`, para no convertirla en controlada read-only.
    const nativeValueProps = onChange
      ? { value: value ?? defaultValue, onChange }
      : { defaultValue };
    return (
      <NativeSelect
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        className={className}
        {...nativeValueProps}
      >
        {children}
      </NativeSelect>
    );
  }

  const handleValueChange = React.useCallback(
    (newValue: string) => {
      onValueChange?.(newValue);
      setOpen(false);
    },
    [onValueChange],
  );

  return (
    <SelectContext.Provider value={{ value, onValueChange: handleValueChange, open, setOpen }}>
      <div className={cn('relative', className)} data-disabled={disabled} id={id}>
        {children}
      </div>
    </SelectContext.Provider>
  );
}

export interface SelectTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export function SelectTrigger({ children, className, id, ...props }: SelectTriggerProps) {
  const ctx = React.useContext(SelectContext);
  if (!ctx) throw new Error('SelectTrigger must be within Select');

  return (
    <button
      type="button"
      id={id}
      onClick={() => ctx.setOpen(!ctx.open)}
      className={cn(
        'flex h-10 w-full items-center justify-between rounded-lg border border-border-strong bg-surface px-3.5 py-2',
        'text-[0.9375rem] text-text',
        'transition-[border-color,box-shadow] duration-150 ease-out',
        'focus:outline-none focus:border-brand-500 focus:shadow-focus',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {children}
      <svg
        className="h-4 w-4 text-text-muted"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

export interface SelectValueProps {
  placeholder?: string;
}

export function SelectValue({ placeholder }: SelectValueProps) {
  const ctx = React.useContext(SelectContext);
  if (!ctx) throw new Error('SelectValue must be within Select');

  return (
    <span className={cn(!ctx.value && 'text-text-muted')}>
      {ctx.value || placeholder || 'Seleccionar...'}
    </span>
  );
}

export interface SelectContentProps {
  children: React.ReactNode;
  className?: string;
}

export function SelectContent({ children, className }: SelectContentProps) {
  const ctx = React.useContext(SelectContext);
  if (!ctx) throw new Error('SelectContent must be within Select');

  if (!ctx.open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => ctx.setOpen(false)} />
      <div
        className={cn(
          'absolute top-full left-0 z-50 mt-1 w-full min-w-[8rem] overflow-hidden rounded-md border border-border bg-surface shadow-lg',
          'animate-in fade-in-0 zoom-in-95',
          className,
        )}
      >
        <div className="max-h-60 overflow-auto p-1">{children}</div>
      </div>
    </>
  );
}

export interface SelectItemProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

export function SelectItem({ value, children, className, disabled }: SelectItemProps) {
  const ctx = React.useContext(SelectContext);
  if (!ctx) throw new Error('SelectItem must be within Select');

  const isSelected = ctx.value === value;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => !disabled && ctx.onValueChange(value)}
      className={cn(
        'relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none',
        'hover:bg-surface-2 focus:bg-surface-2',
        isSelected && 'bg-brand-50 text-brand-700',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      {children}
      {isSelected && (
        <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </span>
      )}
    </button>
  );
}
