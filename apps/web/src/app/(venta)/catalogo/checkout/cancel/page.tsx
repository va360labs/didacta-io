/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';

/**
 * Retorno del checkout PÚBLICO cancelado: sin cargo, se invita a retomar la
 * compra desde el catálogo. No hay sesión que restaurar ni estado que limpiar.
 */
export default async function PublicCheckoutCancelPage() {
  const t = await getTranslations('publicSite');
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-3xl border border-border bg-surface p-8 shadow-sm">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-muted">
        <Icon name="alert" className="h-6 w-6" />
      </span>
      <h1 className="text-xl font-bold">{t('checkoutCancel.title')}</h1>
      <p className="text-text-muted">{t('checkoutCancel.body')}</p>
      <Button asChild variant="ghost">
        <Link href="/catalogo">{t('backToCatalog')}</Link>
      </Button>
    </div>
  );
}
