/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';

/**
 * Retorno del checkout PÚBLICO cancelado: sin cargo, se invita a retomar la
 * compra desde el catálogo. No hay sesión que restaurar ni estado que limpiar.
 */
export default function PublicCheckoutCancelPage() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-3xl border border-border bg-surface p-8 shadow-sm">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-muted">
        <Icon name="alert" className="h-6 w-6" />
      </span>
      <h1 className="text-xl font-bold">Pago cancelado</h1>
      <p className="text-text-muted">
        No se realizó ningún cargo. Puedes retomar la compra cuando quieras — el curso sigue en el
        catálogo.
      </p>
      <Button asChild variant="ghost">
        <Link href="/catalogo">Volver al catálogo</Link>
      </Button>
    </div>
  );
}
