'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { saleStatusKey, saleStatusTone, type SaleRow, type SaleStatus } from '@/lib/sales';
import { cn } from '@/lib/utils';

export const TONE: Record<string, string> = {
  neutral: 'bg-bg-subtle text-text-muted',
  info: 'bg-brand-50 text-brand-700',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
  danger: 'bg-danger-50 text-danger-700',
};

/** Estado de una venta en llano: pagada, retenida, transferida, reembolsada o disputada. */
export function StatusBadge({ sale }: { sale: Pick<SaleRow, 'status' | 'refundState'> }) {
  const t = useTranslations('modoSencilloVentas.datos');
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-[11px] font-bold whitespace-nowrap',
        TONE[saleStatusTone(sale)],
      )}
      data-testid="venta-estado"
    >
      {t(`estado.${saleStatusKey(sale)}` as `estado.${SaleStatus}`)}
    </span>
  );
}
