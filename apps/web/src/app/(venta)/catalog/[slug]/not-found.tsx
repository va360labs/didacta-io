/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';

/**
 * Ficha de un curso que no está a la venta (o no existe): la misma tarjeta de
 * siempre, ahora con un 404 de verdad. Antes era un 200 con el aviso pintado
 * en el navegador, y para un buscador eso es una página más que indexar.
 */
export default async function FichaNoDisponible() {
  const t = await getTranslations('publicSite');
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-3xl border border-border bg-surface p-8 shadow-sm">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-muted">
        <Icon name="alert" className="h-6 w-6" />
      </span>
      <h1 className="text-xl font-bold">{t('ficha.notAvailableTitle')}</h1>
      <p className="text-text-muted">{t('ficha.notAvailableBody')}</p>
      <Button asChild variant="ghost">
        <Link href="/catalog">{t('backToCatalog')}</Link>
      </Button>
    </div>
  );
}
