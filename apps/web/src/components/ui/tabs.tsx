'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createContext, useCallback, useContext, useId, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabs minimales accesibles sin Radix. Pensados para casos
 * controlados/uncontrolled tipo shadcn/ui:
 *   <Tabs defaultValue="datos">
 *     <TabsList>
 *       <TabsTrigger value="datos">Datos</TabsTrigger>
 *       <TabsTrigger value="seguridad">Seguridad</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="datos">…</TabsContent>
 *     <TabsContent value="seguridad">…</TabsContent>
 *   </Tabs>
 *
 * Implementa el WAI-ARIA tab pattern: roles `tablist` / `tab` / `tabpanel`,
 * `aria-selected`, `aria-controls`, `tabIndex` -1/0 y navegación por
 * flechas izquierda/derecha. No incluye Home/End para mantenerlo chico;
 * el caso de uso primario es 2-4 pestañas.
 */

interface TabsContextValue {
  value: string;
  setValue: (next: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(label: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error(`<${label}> debe estar dentro de <Tabs>`);
  return ctx;
}

export interface TabsProps {
  defaultValue?: string;
  value?: string;
  onValueChange?: (next: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  children,
  className,
}: TabsProps): React.JSX.Element {
  const [internal, setInternal] = useState(defaultValue ?? '');
  const current = value ?? internal;
  const baseId = useId();

  const setValue = useCallback(
    (next: string) => {
      if (value === undefined) setInternal(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const ctx = useMemo(() => ({ value: current, setValue, baseId }), [current, setValue, baseId]);

  return (
    <TabsContext.Provider value={ctx}>
      <div className={className} data-state={current}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {}

export function TabsList({ className, children, ...props }: TabsListProps): React.JSX.Element {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-border bg-surface p-1',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'value'
> {
  value: string;
}

export function TabsTrigger({
  value,
  className,
  children,
  ...props
}: TabsTriggerProps): React.JSX.Element {
  const ctx = useTabsContext('TabsTrigger');
  const selected = ctx.value === value;
  const tabId = `${ctx.baseId}-tab-${value}`;
  const panelId = `${ctx.baseId}-panel-${value}`;

  return (
    <button
      id={tabId}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={panelId}
      tabIndex={selected ? 0 : -1}
      data-state={selected ? 'active' : 'inactive'}
      onClick={() => ctx.setValue(value)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const list = e.currentTarget.parentElement;
        if (!list) return;
        const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
        const idx = buttons.indexOf(e.currentTarget);
        if (idx === -1) return;
        const nextIdx =
          e.key === 'ArrowRight'
            ? (idx + 1) % buttons.length
            : (idx - 1 + buttons.length) % buttons.length;
        const target = buttons[nextIdx];
        if (target) {
          target.focus();
          // Activamos al navegar (modo "automatic activation" del tab pattern).
          ctx.setValue(target.getAttribute('data-tab-value') ?? '');
        }
      }}
      data-tab-value={value}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        selected ? 'bg-brand-500 text-text-on-brand shadow-sm' : 'text-text-muted hover:text-text',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({
  value,
  className,
  children,
  ...props
}: TabsContentProps): React.JSX.Element | null {
  const ctx = useTabsContext('TabsContent');
  if (ctx.value !== value) return null;
  const tabId = `${ctx.baseId}-tab-${value}`;
  const panelId = `${ctx.baseId}-panel-${value}`;
  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      tabIndex={0}
      className={cn('focus-visible:outline-none', className)}
      {...props}
    >
      {children}
    </div>
  );
}
