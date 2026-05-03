'use client';

import { forwardRef, useState, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  checked?: boolean;
  onCheckedChange?: (next: boolean) => void;
  /** Etiqueta accesible cuando no hay un Label asociado vía aria-labelledby. */
  label?: string;
}

/**
 * Toggle binario tipo iOS-switch. Pensado para preferencias que se
 * persisten al cambio (auto-save), no para forms con submit. El caller
 * debe persistir en `onCheckedChange` y pasar `disabled` mientras
 * dure el round-trip si quiere bloquear el doble-click.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked: controlledChecked, onCheckedChange, label, disabled, className, ...rest },
  ref,
) {
  const [internalChecked, setInternalChecked] = useState(false);
  const checked = controlledChecked ?? internalChecked;

  const handleChange = () => {
    if (disabled) return;
    const newValue = !checked;
    if (controlledChecked === undefined) {
      setInternalChecked(newValue);
    }
    onCheckedChange?.(newValue);
  };

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={handleChange}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        checked ? 'bg-brand-500' : 'bg-border-strong',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
});
