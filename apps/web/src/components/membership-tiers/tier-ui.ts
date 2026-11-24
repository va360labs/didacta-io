'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';

/**
 * `full`: la tarjeta de la página completa de la membresía (piel de `Card`,
 * como sus hermanas). `simple`: la sección de «Ventas» del modo sencillo
 * (cajas redondeadas, botones altos), como el resto de esa pantalla.
 */
export type TiersVariant = 'full' | 'simple';

/**
 * Textos del editor. Cada modo tiene los suyos —`adminMonetizacion.membership.tiers`
 * en el completo y `modoSencilloVentas.niveles` en el sencillo— con las MISMAS
 * claves (lo fija `tiers-editor.test.tsx`). El tipo es el del sencillo, que no
 * lleva las claves propias de la página completa (`page.*`).
 */
export function useTierTexts(variant: TiersVariant) {
  const full = useTranslations('adminMonetizacion.membership.tiers');
  const simple = useTranslations('modoSencilloVentas.niveles');
  return (variant === 'full' ? full : simple) as unknown as typeof simple;
}

export type TierTexts = ReturnType<typeof useTierTexts>;

/** Clases de cada pieza según el modo (solo densidad y forma; los datos son los mismos). */
export interface TierStyles {
  /** Tarjeta de un nivel. */
  item: string;
  /** Fila de un precio dentro de su nivel. */
  planItem: string;
  /** Caja de un formulario (nivel o precio), en rejilla de dos columnas. */
  form: string;
  /** Lo que ocupa las dos columnas del formulario. */
  span: string;
  /** Campos de texto y selectores. */
  field: string;
  /** Botón principal (guardar, crear). */
  primary: string;
  /** Botón secundario (cancelar, nivel gratis). */
  secondary: string;
  /** Botones pequeños de cada tarjeta (editar, subir, apagar…). */
  action: string;
}

export const TIER_STYLES: Record<TiersVariant, TierStyles> = {
  full: {
    item: 'flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3',
    planItem:
      'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2',
    form: 'grid gap-3 rounded-xl border border-border bg-surface-2 p-4 md:grid-cols-2',
    span: 'md:col-span-2',
    field: '',
    primary: '',
    secondary: '',
    action: '',
  },
  simple: {
    item: 'flex flex-col gap-3 rounded-xl border border-border p-4',
    planItem:
      'flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-subtle px-3 py-2.5',
    form: 'grid gap-3 rounded-xl border border-border bg-bg-subtle p-4 sm:grid-cols-2',
    span: 'sm:col-span-2',
    field:
      'h-11 rounded-xl border-border focus-visible:border-brand-600 focus-visible:ring-4 focus-visible:ring-brand-100',
    primary: 'h-11 rounded-xl bg-brand-600 px-4 text-[15px] font-semibold hover:bg-brand-700',
    secondary:
      'h-11 rounded-xl border-border px-4 text-[15px] font-semibold hover:border-border-strong',
    action: 'h-9 rounded-xl px-3 font-semibold',
  },
};
